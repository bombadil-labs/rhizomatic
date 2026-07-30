{-# LANGUAGE OverloadedStrings #-}

-- | The delta layer (SPEC-1 §2 / §4): typed claims, boundary validation,
-- canonical bytes, content address.
--
-- D14 note (host-boundary numeric policy): in this witness the hazard is
-- discharged by the types — a claims number is only ever a 'Double'; there is
-- no constructor accepting 'Integer', so no native integer term can reach
-- claim construction to be coerced. The one blessed coercion point remains
-- the JSON debug profile parser ('Rhizomatic.Profile').
module Rhizomatic.Delta
  ( Target (..),
    Pointer (..),
    Claims (..),
    validateClaims,
    claimsToCbor,
    canonicalBytes,
    deltaId,
    deltaIdHex,
  )
where

import qualified Data.ByteString as B
import qualified Data.Text as T
import Rhizomatic.Blake3 (blake3)
import Rhizomatic.Cbor (Item (..), encode)
import Rhizomatic.Hex (encodeHex)

data Target
  = TEntity T.Text (Maybe T.Text) -- id, context?
  | TDeltaRef T.Text (Maybe T.Text) -- delta hex, context?
  | TString T.Text
  | TNumber Double
  | TBool Bool
  | TBytes T.Text B.ByteString -- mime, raw payload
  deriving (Eq, Show)

data Pointer = Pointer {pRole :: T.Text, pTarget :: Target} deriving (Eq, Show)

data Claims = Claims {cTimestamp :: Double, cAuthor :: T.Text, cPointers :: [Pointer]} deriving (Eq, Show)

-- | SPEC-1 §2.1 boundary validation: reject, never repair.
validateClaims :: Claims -> Either String ()
validateClaims (Claims ts author ptrs) = do
  finiteNumber "timestamp" ts
  nonEmpty "author" author
  if null ptrs then Left "a delta MUST contain at least one pointer" else Right ()
  mapM_ validatePointer ptrs

validatePointer :: Pointer -> Either String ()
validatePointer (Pointer role target) = do
  nonEmpty "role" role
  case target of
    TEntity _ ctx -> maybe (Right ()) (nonEmpty "context") ctx
    TDeltaRef _ ctx -> maybe (Right ()) (nonEmpty "context") ctx
    TString _ -> Right ()
    TNumber n -> finiteNumber "number primitive" n
    TBool _ -> Right ()
    TBytes mime _ -> nonEmpty "mime" mime

finiteNumber :: String -> Double -> Either String ()
finiteNumber what d
  | isNaN d || isInfinite d = Left (what ++ " must be a finite number")
  | otherwise = Right ()

-- D16: strings are byte-honest — any valid UTF-8 is admitted; NFC is authoring hygiene
-- (SPEC-5 §6), not a boundary law. Only emptiness is checked where the spec demands it.
nonEmpty :: String -> T.Text -> Either String ()
nonEmpty what t
  | T.null t = Left (what ++ " must be non-empty")
  | otherwise = Right ()

-- | SPEC-1 §4.1 claims layout. Callers validate first; this is pure layout.
claimsToCbor :: Claims -> Item
claimsToCbor (Claims ts author ptrs) =
  Map
    [ ("author", TStr author),
      ("pointers", Arr (map pointerToCbor ptrs)),
      ("timestamp", Num ts)
    ]

pointerToCbor :: Pointer -> Item
pointerToCbor (Pointer role target) = Map [("role", TStr role), ("target", targetToCbor target)]

targetToCbor :: Target -> Item
targetToCbor t = case t of
  TEntity eid ctx -> Map (("id", TStr eid) : ctxKv ctx)
  TDeltaRef d ctx -> Map (("delta", TStr d) : ctxKv ctx)
  TString s -> TStr s
  TNumber n -> Num n
  TBool b -> Bool' b
  TBytes mime payload -> Map [("mime", TStr mime), ("value", BStr payload)]
  where
    ctxKv = maybe [] (\c -> [("context", TStr c)])

canonicalBytes :: Claims -> Either String B.ByteString
canonicalBytes claims = do
  validateClaims claims
  Right (encode (claimsToCbor claims))

-- | 34-byte multihash: 0x1e (blake3 multicodec) + 0x20 (length) + digest.
deltaId :: Claims -> Either String B.ByteString
deltaId claims = do
  bytes <- canonicalBytes claims
  Right (B.pack [0x1e, 0x20] <> blake3 bytes)

deltaIdHex :: Claims -> Either String String
deltaIdHex claims = encodeHex <$> deltaId claims
