-- | Canonical deterministic CBOR, the Rhizomatic profile (SPEC-1 §4.1, RFC 8949
-- §4.2.1): definite lengths, shortest-form heads, shortest-form floats down to
-- f16 subnormals, floats only (never integer major types), @-0.0@ → @+0.0@,
-- text-string map keys sorted by their encoded bytes.
--
-- The AST is tagged: 'TStr' vs 'BStr' and float-vs-anything are explicit
-- constructors, so the D14 hazard ("42 and 42.0 name the same claim") is
-- unrepresentable — a number is only ever a 'Double'.
--
-- 'decode' accepts exactly the canonical profile: it structurally decodes,
-- then re-encodes and compares bytes, so every canonicality rule (shortest
-- heads, shortest floats, key order, no duplicate keys) is enforced at once.
module Rhizomatic.Cbor (Item (..), encode, decode) where

import qualified Data.ByteString as B
import Data.Bits (shiftL, shiftR, (.&.), (.|.))
import Data.List (sortOn)
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Data.Word (Word8, Word16, Word64)
import GHC.Float (castDoubleToWord64, castWord64ToDouble, castFloatToWord32, castWord32ToFloat, double2Float, float2Double)

data Item
  = TStr T.Text
  | BStr B.ByteString
  | Num Double
  | Bool' Bool
  | Arr [Item]
  | Map [(T.Text, Item)]
  deriving (Eq, Show)

-- Encoding ------------------------------------------------------------------

encode :: Item -> B.ByteString
encode item = case item of
  TStr t -> withHead 0x60 (TE.encodeUtf8 t)
  BStr b -> withHead 0x40 b
  Num d -> encodeFloat' d
  Bool' False -> B.singleton 0xf4
  Bool' True -> B.singleton 0xf5
  Arr xs -> head' 0x80 (fromIntegral (length xs)) <> B.concat (map encode xs)
  Map kvs ->
    let encoded = [(encode (TStr k), encode v) | (k, v) <- kvs]
        sorted = sortOn fst encoded
     in head' 0xa0 (fromIntegral (length kvs)) <> B.concat [k <> v | (k, v) <- sorted]
  where
    withHead major bytes = head' major (fromIntegral (B.length bytes)) <> bytes

-- | Shortest-form argument head for a major type's high bits.
head' :: Word8 -> Word64 -> B.ByteString
head' major n
  | n < 24 = B.singleton (major .|. fromIntegral n)
  | n < 0x100 = B.pack [major .|. 24, fromIntegral n]
  | n < 0x10000 = B.pack ((major .|. 25) : beBytes 2 n)
  | n < 0x100000000 = B.pack ((major .|. 26) : beBytes 4 n)
  | otherwise = B.pack ((major .|. 27) : beBytes 8 n)

beBytes :: Int -> Word64 -> [Word8]
beBytes k n = [fromIntegral (n `shiftR` (8 * i)) | i <- [k - 1, k - 2 .. 0]]

-- | RFC 8949 §4.2.1 shortest float that represents the value exactly.
-- Callers guarantee finiteness (the boundary rejects NaN/±Inf); -0.0
-- normalizes to +0.0 here (SPEC-1 §4.1).
encodeFloat' :: Double -> B.ByteString
encodeFloat' d0 =
  let d = if isNegativeZero d0 then 0.0 else d0
   in case toF16 d of
        Just w16 -> B.pack (0xf9 : beBytes 2 (fromIntegral w16))
        Nothing ->
          let f = double2Float d
           in if float2Double f == d
                then B.pack (0xfa : beBytes 4 (fromIntegral (castFloatToWord32 f)))
                else B.pack (0xfb : beBytes 8 (castDoubleToWord64 d))

-- | The f16 bits when the double is exactly representable as an IEEE-754
-- binary16 (including subnormals down to 2^-24); Nothing otherwise.
toF16 :: Double -> Maybe Word16
toF16 d
  | d == 0 = Just (if isNegativeZero d then 0x8000 else 0x0000)
  | otherwise =
      let neg = d < 0
          ad = abs d
          (m, e) = decodeFloat ad -- ad = m * 2^e, 2^52 <= m < 2^53
          ebits = e + 52 -- binary exponent of ad
          sign = if neg then 0x8000 else 0x0000 :: Word16
       in if ebits >= -14 && ebits <= 15
            then -- normal range: need <= 11 significant bits
              if m `mod` (2 ^ (42 :: Int)) == 0
                then
                  let frac = fromIntegral ((m `shiftR` 42) .&. 0x3ff) :: Word16
                      expf = fromIntegral (ebits + 15) :: Word16
                   in Just (sign .|. (expf `shiftL` 10) .|. frac)
                else Nothing
            else
              if ebits < -14
                then -- subnormal candidate: ad must be k * 2^-24, 1 <= k < 1024
                  let sh = e + 24
                      k =
                        if sh >= 0
                          then Just (m `shiftL` sh)
                          else
                            if m `mod` (2 ^ negate sh) == 0
                              then Just (m `shiftR` negate sh)
                              else Nothing
                   in case k of
                        Just kv | kv >= 1 && kv < 1024 -> Just (sign .|. fromIntegral kv)
                        _ -> Nothing
                else Nothing

-- Decoding ------------------------------------------------------------------

-- | Decode exactly one canonical item consuming the entire input. Anything
-- outside the profile — indefinite lengths, integer major types, tags, null,
-- non-shortest forms, unsorted or duplicate map keys, NaN/±Inf, invalid
-- UTF-8, non-text map keys, trailing bytes — is rejected.
decode :: B.ByteString -> Either String Item
decode input = do
  (item, rest) <- decodeItem input
  if B.null rest
    then
      if encode item == input
        then Right item
        else Left "cbor: input is not in canonical form"
    else Left "cbor: trailing bytes"

decodeItem :: B.ByteString -> Either String (Item, B.ByteString)
decodeItem bs = do
  (b0, rest) <- uncons bs
  let major = b0 `shiftR` 5
      info = b0 .&. 0x1f
  case major of
    2 -> do
      (n, rest') <- argument info rest
      (bytes, rest'') <- takeExact n rest'
      Right (BStr bytes, rest'')
    3 -> do
      (n, rest') <- argument info rest
      (bytes, rest'') <- takeExact n rest'
      case TE.decodeUtf8' bytes of
        Left _ -> Left "cbor: invalid UTF-8 in text string"
        Right t -> Right (TStr t, rest'')
    4 -> do
      (n, rest') <- argument info rest
      (items, rest'') <- decodeN n rest'
      Right (Arr items, rest'')
    5 -> do
      (n, rest') <- argument info rest
      (kvs, rest'') <- decodePairs n rest'
      Right (Map kvs, rest'')
    7 -> case info of
      20 -> Right (Bool' False, rest)
      21 -> Right (Bool' True, rest)
      25 -> do
        (w, rest') <- beWord 2 rest
        finite (halfToDouble (fromIntegral w)) rest'
      26 -> do
        (w, rest') <- beWord 4 rest
        finite (float2Double (castWord32ToFloat (fromIntegral w))) rest'
      27 -> do
        (w, rest') <- beWord 8 rest
        finite (castWord64ToDouble w) rest'
      _ -> Left "cbor: simple value outside the profile"
    _ -> Left "cbor: major type outside the profile"
  where
    finite d rest'
      | isNaN d || isInfinite d = Left "cbor: non-finite float"
      | otherwise = Right (Num d, rest')

decodeN :: Int -> B.ByteString -> Either String ([Item], B.ByteString)
decodeN 0 bs = Right ([], bs)
decodeN n bs = do
  (x, rest) <- decodeItem bs
  (xs, rest') <- decodeN (n - 1) rest
  Right (x : xs, rest')

decodePairs :: Int -> B.ByteString -> Either String ([(T.Text, Item)], B.ByteString)
decodePairs 0 bs = Right ([], bs)
decodePairs n bs = do
  (k, rest) <- decodeItem bs
  case k of
    TStr kt -> do
      (v, rest') <- decodeItem rest
      (kvs, rest'') <- decodePairs (n - 1) rest'
      if kt `elem` map fst kvs
        then Left "cbor: duplicate map key"
        else Right ((kt, v) : kvs, rest'')
    _ -> Left "cbor: non-text map key"

argument :: Word8 -> B.ByteString -> Either String (Int, B.ByteString)
argument info bs
  | info < 24 = Right (fromIntegral info, bs)
  | info == 24 = first fromIntegral <$> beWord 1 bs
  | info == 25 = first fromIntegral <$> beWord 2 bs
  | info == 26 = first fromIntegral <$> beWord 4 bs
  | info == 27 = first fromIntegral <$> beWord 8 bs
  | otherwise = Left "cbor: indefinite length or reserved info"
  where
    first f (a, b) = (f a, b)

beWord :: Int -> B.ByteString -> Either String (Word64, B.ByteString)
beWord k bs
  | B.length bs < k = Left "cbor: truncated"
  | otherwise =
      let (h, t) = B.splitAt k bs
       in Right (B.foldl' (\acc w -> (acc `shiftL` 8) .|. fromIntegral w) 0 h, t)

takeExact :: Int -> B.ByteString -> Either String (B.ByteString, B.ByteString)
takeExact n bs
  | B.length bs < n = Left "cbor: truncated"
  | otherwise = Right (B.splitAt n bs)

uncons :: B.ByteString -> Either String (Word8, B.ByteString)
uncons bs = maybe (Left "cbor: truncated") Right (B.uncons bs)

-- | IEEE-754 binary16 bits → Double (exact).
halfToDouble :: Word16 -> Double
halfToDouble w =
  let sign = if w .&. 0x8000 /= 0 then -1 else 1 :: Double
      expf = fromIntegral ((w `shiftR` 10) .&. 0x1f) :: Int
      frac = fromIntegral (w .&. 0x3ff) :: Double
   in case expf of
        0 -> sign * frac * 2 ** (-24)
        31 -> sign * (1 / 0) -- rejected by the caller's finiteness check
        _ -> sign * (1 + frac / 1024) * 2 ^^ (expf - 15)
