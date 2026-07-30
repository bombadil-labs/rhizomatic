{-# LANGUAGE OverloadedStrings #-}

-- | The JSON debug profile parser (SPEC-1 §4.2) — the ONE blessed point where
-- a JSON integer token becomes a float (D14). The profile is closed (issue
-- #25): every node carries exactly its own keys; unknown keys reject, and a
-- target object carrying more than one of id/delta/mime is ambiguous and
-- rejects — never resolved by declaration order.
module Rhizomatic.Profile (claimsFromJson) where

import qualified Data.Text as T
import Rhizomatic.Base64Url (decodeB64u)
import Rhizomatic.Delta (Claims (..), Pointer (..), Target (..), validateClaims)
import Rhizomatic.Json (JValue (..))

claimsFromJson :: JValue -> Either String Claims
claimsFromJson v = do
  fields <- asObj "claims" v
  closedKeys "claims" ["timestamp", "author", "pointers"] fields
  ts <- case lookup "timestamp" fields of
    Just (JNum n) -> Right n
    Just _ -> Left "timestamp must be a number"
    Nothing -> Left "timestamp is required"
  author <- case lookup "author" fields of
    Just (JStr s) -> Right s
    Just _ -> Left "author must be a string"
    Nothing -> Left "author is required"
  ptrs <- case lookup "pointers" fields of
    Just (JArr xs) -> mapM pointerFromJson xs
    Just _ -> Left "pointers must be an array"
    Nothing -> Left "pointers must be an array"
  let claims = Claims ts author ptrs
  validateClaims claims
  Right claims

pointerFromJson :: JValue -> Either String Pointer
pointerFromJson v = do
  fields <- asObj "pointer" v
  closedKeys "pointer" ["role", "target"] fields
  role <- case lookup "role" fields of
    Just (JStr s) -> Right s
    Just _ -> Left "role must be a string"
    Nothing -> Left "role is required"
  target <- case lookup "target" fields of
    Just t -> targetFromJson t
    Nothing -> Left "target is required"
  Right (Pointer role target)

targetFromJson :: JValue -> Either String Target
targetFromJson v = case v of
  JStr s -> Right (TString s)
  JNum n -> Right (TNumber n)
  JBool b -> Right (TBool b)
  JNull -> Left "null is not a primitive; must be string | number | boolean"
  JArr _ -> Left "an array is not a primitive nor a ref"
  JObj fields -> do
    let discriminators = [k | k <- ["id", "delta", "mime"], k `elem` map fst fields]
    case discriminators of
      ["id"] -> do
        closedKeys "entity ref" ["id", "context"] fields
        eid <- requireStr "entity ref id" "id" fields
        ctx <- optionalContext fields
        Right (TEntity eid ctx)
      ["delta"] -> do
        closedKeys "delta ref" ["delta", "context"] fields
        d <- requireStr "delta ref delta" "delta" fields
        ctx <- optionalContext fields
        Right (TDeltaRef d ctx)
      ["mime"] -> do
        closedKeys "bytes target" ["mime", "value"] fields
        mime <- requireStr "bytes mime" "mime" fields
        b64 <- requireStr "bytes value" "value" fields
        payload <- decodeB64u (T.unpack b64)
        Right (TBytes mime payload)
      [] -> Left "an object target must be {id, context?}, {delta, context?}, or {mime, value}"
      _ -> Left "ambiguous target: more than one of id/delta/mime"

optionalContext :: [(T.Text, JValue)] -> Either String (Maybe T.Text)
optionalContext fields = case lookup "context" fields of
  Nothing -> Right Nothing
  Just (JStr s) -> Right (Just s)
  Just _ -> Left "context, when present, must be a string"

requireStr :: String -> T.Text -> [(T.Text, JValue)] -> Either String T.Text
requireStr what key fields = case lookup key fields of
  Just (JStr s) -> Right s
  Just _ -> Left (what ++ " must be a string")
  Nothing -> Left (what ++ " is required")

closedKeys :: String -> [T.Text] -> [(T.Text, JValue)] -> Either String ()
closedKeys what allowed fields =
  case [k | (k, _) <- fields, k `notElem` allowed] of
    [] -> Right ()
    (k : _) -> Left (what ++ ": unknown key " ++ show k)

asObj :: String -> JValue -> Either String [(T.Text, JValue)]
asObj _ (JObj fields) = Right fields
asObj what _ = Left (what ++ " must be an object")
