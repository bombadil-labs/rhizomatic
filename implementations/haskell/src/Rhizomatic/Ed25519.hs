-- | Ed25519 (RFC 8032) over Integer field arithmetic — signing, key
-- derivation, and the SPEC-1 §5.1 **strict** acceptance criterion, hand-rolled
-- clause by clause. Never a library's default verifier: the five checks below
-- are the normative text (ERRATA D13), and library notions of "strict" vary.
module Rhizomatic.Ed25519 (derivePublicKey, sign, verifyStrict) where

import qualified Data.ByteString as B
import Data.Bits (shiftL, shiftR, testBit, (.&.), (.|.))
import Data.Word (Word8)
import Rhizomatic.Sha512 (sha512)

p :: Integer
p = 2 ^ (255 :: Int) - 19

l :: Integer
l = 2 ^ (252 :: Int) + 27742317777372353535851937790883648493

d :: Integer
d = (-121665 * inv 121666) `mod` p

-- Extended homogeneous coordinates (X, Y, Z, T) with x = X/Z, y = Y/Z, xy = T/Z.
type Point = (Integer, Integer, Integer, Integer)

basepoint :: Point
basepoint =
  let by = (4 * inv 5) `mod` p
      bx = recoverX by 0
   in (bx, by, 1, (bx * by) `mod` p)

identity :: Point
identity = (0, 1, 1, 0)

inv :: Integer -> Integer
inv a = powMod a (p - 2) p

powMod :: Integer -> Integer -> Integer -> Integer
powMod _ 0 _ = 1
powMod b e m =
  let half = powMod b (e `shiftR` 1) m
      sq = (half * half) `mod` m
   in if testBit e 0 then (sq * (b `mod` m)) `mod` m else sq

pointAdd :: Point -> Point -> Point
pointAdd (x1, y1, z1, t1) (x2, y2, z2, t2) =
  let a = ((y1 - x1) * (y2 - x2)) `mod` p
      b = ((y1 + x1) * (y2 + x2)) `mod` p
      c = (2 * t1 * t2 * d) `mod` p
      dd = (2 * z1 * z2) `mod` p
      e = b - a
      f = dd - c
      g = dd + c
      h = b + a
   in ((e * f) `mod` p, (g * h) `mod` p, (f * g) `mod` p, (e * h) `mod` p)

scalarMult :: Integer -> Point -> Point
scalarMult 0 _ = identity
scalarMult n pt =
  let half = scalarMult (n `shiftR` 1) pt
      doubled = pointAdd half half
   in if testBit n 0 then pointAdd doubled pt else doubled

pointEq :: Point -> Point -> Bool
pointEq (x1, y1, z1, _) (x2, y2, z2, _) =
  (x1 * z2 - x2 * z1) `mod` p == 0 && (y1 * z2 - y2 * z1) `mod` p == 0

-- | x from y and the sign bit; error for non-square (callers use 'decompress'
-- for untrusted input — this is only reached for known-good curve points).
recoverX :: Integer -> Integer -> Integer
recoverX y sign_ = case xCandidate y of
  Just x -> if x `mod` 2 == fromIntegral sign_ then x else p - x
  Nothing -> error "ed25519: not a curve point"

-- | The candidate root with even spelling chosen canonically; Nothing when
-- x^2 = u/v has no root.
xCandidate :: Integer -> Maybe Integer
xCandidate y =
  let u = (y * y - 1) `mod` p
      v = (d * y * y + 1) `mod` p
      xx = (u * inv v) `mod` p
      cand = powMod xx ((p + 3) `shiftR` 3) p
      cand' = if (cand * cand) `mod` p == xx then cand else (cand * powMod 2 ((p - 1) `shiftR` 2) p) `mod` p
   in if (cand' * cand') `mod` p == xx then Just cand' else Nothing

compress :: Point -> B.ByteString
compress pt@(_, _, z, _) =
  let zi = inv z
      (x', y', _, _) = pt
      x = (x' * zi) `mod` p
      y = (y' * zi) `mod` p
      enc = y .|. ((x .&. 1) `shiftL` 255)
   in leBytes 32 enc

-- | Strict decompression: the 32 bytes must decode to a curve point whose
-- re-compression reproduces the identical bytes (SPEC-1 §5.1 checks 2–3:
-- rejects y >= p and a set sign bit when x = 0).
decompress :: B.ByteString -> Maybe Point
decompress bs
  | B.length bs /= 32 = Nothing
  | otherwise =
      let n = leInteger bs
          y = n .&. (2 ^ (255 :: Int) - 1)
          sign_ = n `shiftR` 255
       in if y >= p
            then Nothing
            else case xCandidate y of
              Nothing -> Nothing
              Just cand ->
                let x = if cand `mod` 2 == sign_ then cand else p - cand
                    pt = (x, y, 1, (x * y) `mod` p)
                 in if compress pt == bs then Just pt else Nothing

clamp :: B.ByteString -> Integer
clamp h =
  let n = leInteger (B.take 32 h)
   in (n .&. (2 ^ (254 :: Int) - 8)) .|. 2 ^ (254 :: Int)

-- | Public key bytes from a 32-byte seed.
derivePublicKey :: B.ByteString -> B.ByteString
derivePublicKey seed = compress (scalarMult (clamp (sha512 seed)) basepoint)

-- | RFC 8032 deterministic signature (64 bytes) over @msg@ by @seed@.
sign :: B.ByteString -> B.ByteString -> B.ByteString
sign seed msg =
  let h = sha512 seed
      s = clamp h
      prefix = B.drop 32 h
      pub = compress (scalarMult s basepoint)
      r = leInteger (sha512 (prefix <> msg)) `mod` l
      rPoint = compress (scalarMult r basepoint)
      k = leInteger (sha512 (rPoint <> pub <> msg)) `mod` l
      sScalar = (r + k * s) `mod` l
   in rPoint <> leBytes 32 sScalar

-- | SPEC-1 §5.1: the five checks, in the spec's order. True iff all hold.
verifyStrict :: B.ByteString -> B.ByteString -> B.ByteString -> Bool
verifyStrict pubBytes msg sigBytes
  | B.length sigBytes /= 64 || B.length pubBytes /= 32 = False
  | otherwise =
      let rBytes = B.take 32 sigBytes
          sBytes = B.drop 32 sigBytes
          sScalar = leInteger sBytes
       in -- 1. canonical scalar
          sScalar < l
            && case (decompress pubBytes, decompress rBytes) of
              -- 2–3. canonical encodings of A and R
              (Just aPoint, Just rPoint) ->
                -- 4. no small-order components: [8]A ≠ O and [8]R ≠ O
                not (pointEq (scalarMult 8 aPoint) identity)
                  && not (pointEq (scalarMult 8 rPoint) identity)
                  -- 5. cofactorless equation: [S]B = R + [k]A
                  && let k = leInteger (sha512 (rBytes <> pubBytes <> msg)) `mod` l
                      in pointEq (scalarMult sScalar basepoint) (pointAdd rPoint (scalarMult k aPoint))
              _ -> False

leInteger :: B.ByteString -> Integer
leInteger = B.foldr (\w acc -> (acc `shiftL` 8) .|. fromIntegral w) 0

leBytes :: Int -> Integer -> B.ByteString
leBytes n x = B.pack [fromIntegral (x `shiftR` (8 * i)) :: Word8 | i <- [0 .. n - 1]]
