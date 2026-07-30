-- | BLAKE3-256, hand-rolled from the BLAKE3 specification (like the SHA-512 /
-- Ed25519 modules: external standards, boring transcription; correctness over
-- speed everywhere). Only the 32-byte single-output mode the format needs.
module Rhizomatic.Blake3 (blake3) where

import qualified Data.ByteString as B
import Data.Bits (rotateR, shiftL, shiftR, xor, (.&.), (.|.))
import Data.List (foldl')
import Data.Word (Word32, Word64, Word8)

iv :: [Word32]
iv = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

chunkStart, chunkEnd, parent, root :: Word32
chunkStart = 1
chunkEnd = 2
parent = 4
root = 8

-- | 32-byte BLAKE3 hash of the input.
blake3 :: B.ByteString -> B.ByteString
blake3 input =
  let chunks = chunksOf 1024 input
      n = length chunks
   in if n <= 1
        then chunkCv (if B.null input then B.empty else head chunks) 0 root
        else wordsToBytes (subtree chunks 0 True)
  where
    -- Chaining value of a subtree of chunks starting at chunk index i0.
    subtree :: [B.ByteString] -> Word64 -> Bool -> [Word32]
    subtree [c] i0 _ = bytesToWords (chunkCv c i0 0)
    subtree cs i0 isRoot =
      let total = length cs
          leftN = largestPowerOfTwoBelow total
          (l, r) = splitAt leftN cs
          lcv = subtree l i0 False
          rcv = subtree r (i0 + fromIntegral leftN) False
          block = lcv ++ rcv
          flags = parent .|. (if isRoot then root else 0)
       in take 8 (compress iv block 0 64 flags)

-- | The chaining value of one chunk (rootFlags is OR'd into the final block's
-- flags — 'root' when the whole input is a single chunk).
chunkCv :: B.ByteString -> Word64 -> Word32 -> B.ByteString
chunkCv chunk counter rootFlags =
  let blocks = if B.null chunk then [B.empty] else chunksOf 64 chunk
      lastIdx = length blocks - 1
      step (cv, i) blk =
        let flags =
              (if i == 0 then chunkStart else 0)
                .|. (if i == lastIdx then chunkEnd .|. rootFlags else 0)
            m = bytesToWords (padTo 64 blk)
         in (take 8 (compress cv m counter (fromIntegral (B.length blk)) flags), i + 1)
   in wordsToBytes (fst (foldl' step (iv, 0 :: Int) blocks))

largestPowerOfTwoBelow :: Int -> Int
largestPowerOfTwoBelow n = go 1 where go p = if p * 2 < n then go (p * 2) else p

compress :: [Word32] -> [Word32] -> Word64 -> Word32 -> Word32 -> [Word32]
compress cv block counter blockLen flags =
  let v0 =
        cv
          ++ take 4 iv
          ++ [fromIntegral (counter .&. 0xffffffff), fromIntegral (counter `shiftR` 32), blockLen, flags]
      (v7, _) = iterate roundStep (v0, block) !! 7
      out = zipWith xor (take 8 v7) (drop 8 v7)
   in out ++ zipWith xor (drop 8 v7) cv
  where
    roundStep (v, m) = (oneRound v m, permute m)

permute :: [Word32] -> [Word32]
permute m = map (m !!) [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8]

oneRound :: [Word32] -> [Word32] -> [Word32]
oneRound v m =
  let g' st (a, b, c, d, mi) = g st a b c d (m !! (2 * mi)) (m !! (2 * mi + 1))
      afterCols = foldl' g' v [(0, 4, 8, 12, 0), (1, 5, 9, 13, 1), (2, 6, 10, 14, 2), (3, 7, 11, 15, 3)]
   in foldl' g' afterCols [(0, 5, 10, 15, 4), (1, 6, 11, 12, 5), (2, 7, 8, 13, 6), (3, 4, 9, 14, 7)]

g :: [Word32] -> Int -> Int -> Int -> Int -> Word32 -> Word32 -> [Word32]
g v a b c d mx my =
  let va1 = (v !! a) + (v !! b) + mx
      vd1 = ((v !! d) `xor` va1) `rotateR` 16
      vc1 = (v !! c) + vd1
      vb1 = ((v !! b) `xor` vc1) `rotateR` 12
      va2 = va1 + vb1 + my
      vd2 = (vd1 `xor` va2) `rotateR` 8
      vc2 = vc1 + vd2
      vb2 = (vb1 `xor` vc2) `rotateR` 7
      pick i
        | i == a = va2
        | i == b = vb2
        | i == c = vc2
        | i == d = vd2
        | otherwise = v !! i
   in map pick [0 .. 15]

chunksOf :: Int -> B.ByteString -> [B.ByteString]
chunksOf n bs
  | B.length bs <= n = [bs]
  | otherwise = let (h, t) = B.splitAt n bs in h : chunksOf n t

padTo :: Int -> B.ByteString -> B.ByteString
padTo n bs = bs <> B.replicate (n - B.length bs) 0

bytesToWords :: B.ByteString -> [Word32]
bytesToWords bs =
  [ le32 (B.take 4 (B.drop (4 * i) bs))
    | i <- [0 .. B.length bs `div` 4 - 1]
  ]
  where
    le32 b = B.foldr (\w acc -> (acc `shiftL` 8) .|. fromIntegral w) 0 b

wordsToBytes :: [Word32] -> B.ByteString
wordsToBytes = B.pack . concatMap le
  where
    le :: Word32 -> [Word8]
    le w = [fromIntegral (w `shiftR` (8 * i)) | i <- [0 .. 3]]
