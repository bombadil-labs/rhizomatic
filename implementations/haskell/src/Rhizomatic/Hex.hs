-- | Lowercase hex at every boundary (SPEC-1 §4.1): encode emits lowercase,
-- decode rejects uppercase, odd length, and non-hex bytes — reject, never repair.
module Rhizomatic.Hex (encodeHex, decodeHex) where

import qualified Data.ByteString as B
import Data.Bits (shiftL, shiftR, (.&.), (.|.))
import Data.Word (Word8)

encodeHex :: B.ByteString -> String
encodeHex = concatMap byte . B.unpack
  where
    byte w = [digit (fromIntegral (w `shiftR` 4)), digit (fromIntegral (w .&. 0x0f))]
    digit n = "0123456789abcdef" !! n

decodeHex :: String -> Either String B.ByteString
decodeHex s
  | odd (length s) = Left "hex: odd length"
  | otherwise = B.pack <$> pairs s
  where
    pairs [] = Right []
    pairs (a : b : rest) = do
      hi <- nibble a
      lo <- nibble b
      ((hi `shiftL` 4) .|. lo :) <$> pairs rest
    pairs _ = Left "hex: odd length"
    nibble :: Char -> Either String Word8
    nibble c
      | c >= '0' && c <= '9' = Right (fromIntegral (fromEnum c - fromEnum '0'))
      | c >= 'a' && c <= 'f' = Right (fromIntegral (fromEnum c - fromEnum 'a' + 10))
      | otherwise = Left ("hex: invalid character " ++ show c)
