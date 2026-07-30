{-# LANGUAGE OverloadedStrings #-}

module Main where

import qualified Data.ByteString.Char8 as BC
import qualified Data.Text as T
import Harness
import Rhizomatic.Blake3 (blake3)
import Rhizomatic.Cbor (Item (..), decode, encode)
import Rhizomatic.Delta (canonicalBytes, deltaIdHex)
import Rhizomatic.Ed25519 (derivePublicKey)
import Rhizomatic.Hex (decodeHex, encodeHex)
import Rhizomatic.Json (JValue (..), parseJson)
import Rhizomatic.Nfc (isNfc)
import Rhizomatic.Profile (claimsFromJson)
import Rhizomatic.Signer (signDelta, verifyDelta)

main :: IO ()
main =
  runSuites
    [ ("json-parser", pure jsonParserTests),
      ("cbor-primitives", cborPrimitiveTests),
      ("blake3-known-answers", pure blake3Tests),
      ("boundary", pure boundaryTests),
      ("deltas", deltaFileTests "l0-delta/deltas.json"),
      ("deltas-bytes", deltaFileTests "l0-delta/deltas-bytes.json"),
      ("deltas-invalid", deltasInvalidTests),
      ("keys", keysTests),
      ("deltas-signed", deltasSignedTests),
      ("deltas-sig-edge", sigEdgeTests)
    ]

-- keys.json: derive each public key from its seed and match the pinned bytes.
keysTests :: IO [Test]
keysTests = do
  JArr keys <- loadVectors "keys/keys.json"
  pure (map keyCase keys)
  where
    keyCase (JObj fields) =
      case (lookup "keyId" fields, lookup "seedHex" fields, lookup "publicKeyHex" fields, lookup "author" fields) of
        (Just (JStr kid), Just (JStr seedT), Just (JStr pubT), Just (JStr authorT)) ->
          let n = T.unpack kid
           in case decodeHex (T.unpack seedT) of
                Left err -> failure n err
                Right seed ->
                  let pubHex = encodeHex (derivePublicKey seed)
                   in ( n,
                        if pubHex == T.unpack pubT && T.unpack authorT == "ed25519:" ++ pubHex
                          then Right ()
                          else Left ("derived " ++ pubHex ++ ", pinned " ++ T.unpack pubT)
                      )
        _ -> failure "key-case" "malformed vector entry"
    keyCase _ = failure "key-case" "vector entry is not an object"

-- deltas-signed.json: canonical bytes and id as usual, then *reproduce* the
-- pinned deterministic signature bytes from the named key, then verify.
deltasSignedTests :: IO [Test]
deltasSignedTests = do
  JArr keys <- loadVectors "keys/keys.json"
  let seeds = [(kid, seedT) | JObj f <- keys, Just (JStr kid) <- [lookup "keyId" f], Just (JStr seedT) <- [lookup "seedHex" f]]
  JArr cases <- loadVectors "l0-delta/deltas-signed.json"
  pure (concatMap (signedCase seeds) cases)
  where
    signedCase seeds (JObj fields) =
      case (lookup "name" fields, lookup "keyId" fields, lookup "claims" fields, lookup "canonicalCborHex" fields, lookup "id" fields, lookup "sig" fields) of
        (Just (JStr nameT), Just (JStr kid), Just claimsJson, Just (JStr hexT), Just (JStr idT), Just (JStr sigT)) ->
          let n = T.unpack nameT
           in case (claimsFromJson claimsJson, lookup kid seeds) of
                (Left err, _) -> [failure n ("claims rejected: " ++ err)]
                (_, Nothing) -> [failure n ("unknown keyId " ++ T.unpack kid)]
                (Right claims, Just seedT) ->
                  case decodeHex (T.unpack seedT) of
                    Left err -> [failure n err]
                    Right seed ->
                      [ expectEq (n ++ "/canonical-bytes") (encodeHex <$> canonicalBytes claims) (Right (T.unpack hexT)),
                        expectEq (n ++ "/id") (deltaIdHex claims) (Right (T.unpack idT)),
                        expectEq (n ++ "/sig-reproduced") (signDelta seed claims) (Right (T.unpack sigT)),
                        expectEq (n ++ "/verifies") (verifyDelta claims (T.unpack idT) (T.unpack sigT)) (Right True)
                      ]
        _ -> [failure "signed-case" "malformed vector entry"]
    signedCase _ _ = [failure "signed-case" "vector entry is not an object"]

-- deltas-sig-edge.json: the §5.1 strict criterion, clause by clause.
sigEdgeTests :: IO [Test]
sigEdgeTests = do
  JArr cases <- loadVectors "l0-delta/deltas-sig-edge.json"
  pure (map edgeCase cases)
  where
    edgeCase (JObj fields) =
      case (lookup "name" fields, lookup "claims" fields, lookup "id" fields, lookup "sig" fields, lookup "verdict" fields) of
        (Just (JStr nameT), Just claimsJson, Just (JStr idT), Just (JStr sigT), Just (JStr verdictT)) ->
          let n = T.unpack nameT
              want = verdictT == "verified"
           in case claimsFromJson claimsJson of
                Left err -> failure n ("claims rejected: " ++ err)
                Right claims ->
                  case verifyDelta claims (T.unpack idT) (T.unpack sigT) of
                    Left err -> failure n ("verification errored: " ++ err)
                    Right got ->
                      ( n,
                        if got == want
                          then Right ()
                          else Left ("verdict " ++ show got ++ ", vector pins " ++ show want)
                      )
        _ -> failure "sig-edge-case" "malformed vector entry"
    edgeCase _ = failure "sig-edge-case" "vector entry is not an object"

-- BLAKE3 known answers (input = the reference suite's repeating 0..250 byte
-- pattern; digests cross-checked against the official blake3 implementation),
-- so a subtle compression/tree bug fails here instead of as a baffling id
-- mismatch. Lengths chosen to hit: empty, single block, partial/full/overfull
-- chunk, balanced and unbalanced trees, and a 100-chunk tree.
blake3Tests :: [Test]
blake3Tests =
  [ known 0 "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    known 1 "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213",
    known 1023 "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11",
    known 1024 "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7",
    known 1025 "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444",
    known 2048 "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a",
    known 3072 "b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2",
    known 4096 "015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969",
    known 5001 "5404586088ac669a4333507f97a093197d16972d09ac2764a9a20542322104fa",
    known 8192 "aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63",
    known 102400 "bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085"
  ]
  where
    pattern n = BC.pack (map (toEnum . (`mod` 251)) [0 .. n - 1])
    known n want = expectEq ("blake3-len-" ++ show n) (encodeHex (blake3 (pattern n))) want

-- Host-boundary policies a JSON file cannot express (vectors/README.md §3).
boundaryTests :: [Test]
boundaryTests =
  [ expect "non-nfc-is-detected" (not (isNfc "e\x0301")) "e + combining acute accepted as NFC",
    expect "nfc-is-accepted" (isNfc "\x00e9") "precomposed \233 rejected",
    expect "hangul-nfc" (isNfc "\xac00" && not (isNfc "\x1100\x1161")) "Hangul composition wrong",
    -- D14: native integer terms cannot reach claim construction in this
    -- witness — the claims number type is Double; there is no Integer
    -- constructor. The profile half (integer token = float spelling) is
    -- pinned by the number-integer-spelling vector in deltas.json.
    ok "d14-native-int-unrepresentable-by-construction"
  ]

deltaFileTests :: String -> IO [Test]
deltaFileTests file = do
  JArr cases <- loadVectors file
  pure (concatMap deltaCase cases)

deltaCase :: JValue -> [Test]
deltaCase (JObj fields) =
  case (lookup "name" fields, lookup "claims" fields, lookup "canonicalCborHex" fields, lookup "id" fields) of
    (Just (JStr nameT), Just claimsJson, Just (JStr hexT), Just (JStr idT)) ->
      let n = T.unpack nameT
       in case claimsFromJson claimsJson of
            Left err -> [failure n ("claims rejected: " ++ err)]
            Right claims ->
              [ expectEq (n ++ "/canonical-bytes") (encodeHex <$> canonicalBytes claims) (Right (T.unpack hexT)),
                expectEq (n ++ "/id") (deltaIdHex claims) (Right (T.unpack idT))
              ]
    _ -> [failure "delta-case" "malformed vector entry"]
deltaCase _ = [failure "delta-case" "vector entry is not an object"]

deltasInvalidTests :: IO [Test]
deltasInvalidTests = do
  JArr cases <- loadVectors "l0-delta/deltas-invalid.json"
  pure (map invalidCase cases)
  where
    invalidCase (JObj fields) =
      case (lookup "name" fields, lookup "claims" fields) of
        (Just (JStr nameT), Just claimsJson) ->
          let n = T.unpack nameT
           in case claimsFromJson claimsJson of
                Left _ -> ok n
                Right _ -> failure n "malformed claims were accepted"
        _ -> failure "invalid-case" "malformed vector entry"
    invalidCase _ = failure "invalid-case" "vector entry is not an object"

-- vectors/README.md: before anything else, test the JSON parser directly.
jsonParserTests :: [Test]
jsonParserTests =
  [ expectEq "f16-min-subnormal-is-2^-24" (parseJson "5.960464477539063e-8") (Right (JNum (2 ** (-24)))),
    expectEq "integer-spelling" (parseJson "42") (Right (JNum 42.0)),
    expectEq "point-one-correctly-rounded" (parseJson "0.1") (Right (JNum 0.1))
  ]

cborPrimitiveTests :: IO [Test]
cborPrimitiveTests = do
  JArr cases <- loadVectors "l0-delta/cbor-primitives.json"
  pure (concatMap primitiveCase cases)

primitiveCase :: JValue -> [Test]
primitiveCase (JObj fields) =
  case (lookup "name" fields, lookup "kind" fields, lookup "value" fields, lookup "hex" fields) of
    (Just (JStr name), Just (JStr kind), Just value, Just (JStr hexT)) ->
      let n = T.unpack name
          hex = T.unpack hexT
       in case itemFor (T.unpack kind) value of
            Left err -> [failure n err]
            Right item ->
              let bytes = encode item
               in [ expectEq (n ++ "/encode") (encodeHex bytes) hex,
                    expectEq (n ++ "/decode") (either Left (Right . encode) (decodeHexed hex)) (Right bytes)
                  ]
    _ -> [failure "primitive-case" "malformed vector entry"]
  where
    decodeHexed hex = decodeHex hex >>= decode
primitiveCase _ = [failure "primitive-case" "vector entry is not an object"]

itemFor :: String -> JValue -> Either String Item
itemFor "float" (JNum d) = Right (Num d)
itemFor "tstr" (JStr t) = Right (TStr t)
itemFor "bool" (JBool b) = Right (Bool' b)
itemFor "bstr" (JStr hexT) = BStr <$> decodeHex (T.unpack hexT)
itemFor kind v = Left ("unhandled primitive kind " ++ kind ++ " / " ++ show v)
