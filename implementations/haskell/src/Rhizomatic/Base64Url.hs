-- | Canonical unpadded base64url (RFC 4648 §5; SPEC-1 §4.2 / ERRATA D12).
-- Decode rejects: '=' padding, non-alphabet bytes, length ≡ 1 (mod 4), and
-- nonzero spilled bits in the final character ("Zh" decodes to 0x66 with
-- nonzero trailing bits; only "Zg" is canonical). Reject, never repair.
module Rhizomatic.Base64Url (encodeB64u, decodeB64u) where

import qualified Data.ByteString as B
import Data.Bits (shiftL, shiftR, (.&.), (.|.))
import Data.List (elemIndex)
import Data.Word (Word8)

alphabet :: String
alphabet = ['A' .. 'Z'] ++ ['a' .. 'z'] ++ ['0' .. '9'] ++ "-_"

encodeB64u :: B.ByteString -> String
encodeB64u = go . B.unpack
  where
    go [] = []
    go [a] =
      let n = fromIntegral a `shiftL` 4 :: Int
       in [alphabet !! (n `shiftR` 6), alphabet !! (n .&. 0x3f)]
    go [a, b] =
      let n = (fromIntegral a `shiftL` 10) .|. (fromIntegral b `shiftL` 2) :: Int
       in [alphabet !! (n `shiftR` 12), alphabet !! ((n `shiftR` 6) .&. 0x3f), alphabet !! (n .&. 0x3f)]
    go (a : b : c : rest) =
      let n = (fromIntegral a `shiftL` 16) .|. (fromIntegral b `shiftL` 8) .|. fromIntegral c :: Int
       in alphabet !! (n `shiftR` 18)
            : alphabet !! ((n `shiftR` 12) .&. 0x3f)
            : alphabet !! ((n `shiftR` 6) .&. 0x3f)
            : alphabet !! (n .&. 0x3f)
            : go rest

decodeB64u :: String -> Either String B.ByteString
decodeB64u s
  | length s `mod` 4 == 1 = Left "base64url: length \8801 1 (mod 4)"
  | otherwise = B.pack <$> go s
  where
    go [] = Right []
    go cs = do
      let (grp, rest) = splitAt 4 cs
      vals <- mapM val grp
      case vals of
        [a, b, c, d] -> ((bytesOf3 a b c d ++) <$> go rest)
        [a, b, c] ->
          let n = (a `shiftL` 18) .|. (b `shiftL` 12) .|. (c `shiftL` 6)
           in if c .&. 0x03 /= 0
                then Left "base64url: nonzero trailing bits"
                else Right [byte (n `shiftR` 16), byte (n `shiftR` 8)]
        [a, b] ->
          let n = (a `shiftL` 18) .|. (b `shiftL` 12)
           in if b .&. 0x0f /= 0
                then Left "base64url: nonzero trailing bits"
                else Right [byte (n `shiftR` 16)]
        _ -> Left "base64url: internal length error"
    bytesOf3 a b c d =
      let n = (a `shiftL` 18) .|. (b `shiftL` 12) .|. (c `shiftL` 6) .|. d
       in [byte (n `shiftR` 16), byte (n `shiftR` 8), byte n]
    byte :: Int -> Word8
    byte = fromIntegral . (.&. 0xff)
    val :: Char -> Either String Int
    val ch = case elemIndex ch alphabet of
      Just i -> Right i
      Nothing -> Left ("base64url: invalid character " ++ show ch)
