{-# LANGUAGE OverloadedStrings #-}

-- | Signing and verification at the delta level (SPEC-1 §5): author↔key match
-- is enforced on sign (a signature that contradicts its own author field is
-- born broken); verification recomputes the id from the claims, then runs the
-- §5.1 strict Ed25519 criterion over the raw 34-byte multihash.
module Rhizomatic.Signer (signDelta, verifyDelta) where

import qualified Data.ByteString as B
import qualified Data.Text as T
import Rhizomatic.Delta (Claims (..), deltaId)
import Rhizomatic.Ed25519 (derivePublicKey, sign, verifyStrict)
import Rhizomatic.Hex (decodeHex, encodeHex)

-- | Detached signature (hex) over the delta's raw id bytes by the seed's key.
-- Refuses to sign claims whose author does not name the signing key.
signDelta :: B.ByteString -> Claims -> Either String String
signDelta seed claims = do
  let expected = "ed25519:" <> T.pack (encodeHex (derivePublicKey seed))
  if cAuthor claims /= expected
    then Left "author does not match the signing key"
    else do
      idBytes <- deltaId claims
      Right (encodeHex (sign seed idBytes))

-- | Full §5 verification: the id recomputes from the claims, then the
-- signature verifies over the raw id bytes against the key named in author.
verifyDelta :: Claims -> String -> String -> Either String Bool
verifyDelta claims idHex sigHex = do
  idBytes <- deltaId claims
  if encodeHex idBytes /= idHex
    then Right False
    else case T.stripPrefix "ed25519:" (cAuthor claims) of
      Nothing -> Left "author is not an ed25519 key"
      Just keyHex -> do
        pub <- decodeHex (T.unpack keyHex)
        sig <- decodeHex sigHex
        Right (verifyStrict pub idBytes sig)
