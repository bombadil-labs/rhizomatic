-- | The D10 set digest (PROVISIONAL helper, SPEC-1 ERRATA): a canonical
-- fingerprint of delta-set membership. digest(S) = contentAddress(canonical
-- CBOR array of S's id strings, sorted lexicographically). NOT the SPEC-6 §4
-- reconciliation digest.
module Rhizomatic.SetDigest (setDigestHex) where

import qualified Data.ByteString as B
import Data.List (nub, sort)
import qualified Data.Text as T
import Rhizomatic.Blake3 (blake3)
import Rhizomatic.Cbor (Item (..), encode)
import Rhizomatic.Hex (encodeHex)

-- | Lowercase-hex multihash digest of a set of id hex strings. Input order is
-- irrelevant; duplicates collapse (a delta set is a set).
setDigestHex :: [String] -> String
setDigestHex ids =
  let sorted = sort (nub ids)
      bytes = encode (Arr (map (TStr . T.pack) sorted))
   in encodeHex (B.pack [0x1e, 0x20] <> blake3 bytes)
