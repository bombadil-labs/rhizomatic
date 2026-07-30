{-# LANGUAGE OverloadedStrings #-}

module Main where

import qualified Data.Text as T
import Harness
import Rhizomatic.Cbor (Item (..), decode, encode)
import Rhizomatic.Hex (decodeHex, encodeHex)
import Rhizomatic.Json (JValue (..), parseJson)

main :: IO ()
main =
  runSuites
    [ ("json-parser", pure jsonParserTests),
      ("cbor-primitives", cborPrimitiveTests)
    ]

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
