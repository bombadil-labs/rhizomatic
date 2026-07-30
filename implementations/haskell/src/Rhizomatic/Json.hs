-- | A hand-rolled JSON parser for the conformance vectors and the SPEC-1 §4.2
-- JSON debug profile. Zero dependencies (GHC boot packages only).
--
-- Number parsing is **correctly rounded** (SPEC-1 §4.2: nearest f64,
-- ties-to-even): the token is read exactly into a Rational and converted with
-- 'fromRational', whose @fromRat@ implementation performs correctly-rounded
-- conversion. The @float-f16-min-subnormal@ vector guards this end-to-end, and
-- test/Main.hs asserts the 2^-24 parse directly (vectors/README.md's first
-- instruction to a new witness).
--
-- Object member order is preserved and duplicate keys are rejected — a
-- duplicate key silently resolved either way is repair (SPEC-4 §2).
module Rhizomatic.Json (JValue (..), parseJson) where

import Data.Char (chr, isDigit, isHexDigit, digitToInt, ord)
import Data.List (foldl')
import Data.Ratio ((%))
import qualified Data.Text as T

data JValue
  = JNull
  | JBool Bool
  | JNum Double
  | JStr T.Text
  | JArr [JValue]
  | JObj [(T.Text, JValue)]
  deriving (Eq, Show)

type P a = String -> Either String (a, String)

parseJson :: String -> Either String JValue
parseJson input = do
  (v, rest) <- pValue (skipWs input)
  case skipWs rest of
    "" -> Right v
    _ -> Left "json: trailing content"

skipWs :: String -> String
skipWs (c : cs) | c `elem` " \t\n\r" = skipWs cs
skipWs s = s

pValue :: P JValue
pValue s = case s of
  'n' : 'u' : 'l' : 'l' : rest -> Right (JNull, rest)
  't' : 'r' : 'u' : 'e' : rest -> Right (JBool True, rest)
  'f' : 'a' : 'l' : 's' : 'e' : rest -> Right (JBool False, rest)
  '"' : rest -> do
    (t, rest') <- pStringBody rest
    Right (JStr t, rest')
  '[' : rest -> pArray (skipWs rest)
  '{' : rest -> pObject (skipWs rest)
  c : _ | c == '-' || isDigit c -> pNumber s
  _ -> Left "json: unexpected input"

pArray :: P JValue
pArray (']' : rest) = Right (JArr [], rest)
pArray s = go s []
  where
    go str acc = do
      (v, rest) <- pValue (skipWs str)
      case skipWs rest of
        ',' : rest' -> go rest' (v : acc)
        ']' : rest' -> Right (JArr (reverse (v : acc)), rest')
        _ -> Left "json: expected , or ] in array"

pObject :: P JValue
pObject ('}' : rest) = Right (JObj [], rest)
pObject s = go s []
  where
    go str acc = case skipWs str of
      '"' : rest -> do
        (k, rest') <- pStringBody rest
        if k `elem` map fst acc
          then Left ("json: duplicate object key " ++ show k)
          else case skipWs rest' of
            ':' : rest'' -> do
              (v, rest3) <- pValue (skipWs rest'')
              case skipWs rest3 of
                ',' : rest4 -> go rest4 ((k, v) : acc)
                '}' : rest4 -> Right (JObj (reverse ((k, v) : acc)), rest4)
                _ -> Left "json: expected , or } in object"
            _ -> Left "json: expected : after key"
      _ -> Left "json: expected string key"

-- Parses the body of a string after the opening quote.
pStringBody :: P T.Text
pStringBody = go []
  where
    go acc ('"' : rest) = Right (T.pack (reverse acc), rest)
    go acc ('\\' : e : rest) = case e of
      '"' -> go ('"' : acc) rest
      '\\' -> go ('\\' : acc) rest
      '/' -> go ('/' : acc) rest
      'b' -> go ('\b' : acc) rest
      'f' -> go ('\f' : acc) rest
      'n' -> go ('\n' : acc) rest
      'r' -> go ('\r' : acc) rest
      't' -> go ('\t' : acc) rest
      'u' -> do
        (n, rest') <- hex4 rest
        if n >= 0xd800 && n <= 0xdbff
          then case rest' of
            '\\' : 'u' : rest'' -> do
              (lo, rest3) <- hex4 rest''
              if lo >= 0xdc00 && lo <= 0xdfff
                then go (chr (0x10000 + (n - 0xd800) * 0x400 + (lo - 0xdc00)) : acc) rest3
                else Left "json: unpaired high surrogate"
            _ -> Left "json: unpaired high surrogate"
          else
            if n >= 0xdc00 && n <= 0xdfff
              then Left "json: unpaired low surrogate"
              else go (chr n : acc) rest'
      _ -> Left "json: invalid escape"
    go acc (c : rest)
      | ord c < 0x20 = Left "json: unescaped control character"
      | otherwise = go (c : acc) rest
    go _ [] = Left "json: unterminated string"
    hex4 (a : b : c : d : rest)
      | all isHexDigit [a, b, c, d] =
          Right (foldl' (\n x -> n * 16 + digitToInt x) 0 [a, b, c, d], rest)
    hex4 _ = Left "json: invalid \\u escape"

pNumber :: P JValue
pNumber s0 = do
  let (neg, s1) = case s0 of
        '-' : rest -> (True, rest)
        _ -> (False, s0)
  (intDigits, s2) <- digits1 s1
  _ <-
    if length intDigits > 1 && head intDigits == '0'
      then Left "json: leading zero"
      else Right ()
  (fracDigits, s3) <- case s2 of
    '.' : rest -> digits1 rest
    _ -> Right ("", s2)
  (expVal, s4) <- case s3 of
    e : rest | e == 'e' || e == 'E' -> do
      let (esign, rest') = case rest of
            '+' : r -> (1 :: Integer, r)
            '-' : r -> (-1, r)
            r -> (1, r)
      (eDigits, rest'') <- digits1 rest'
      Right (esign * read eDigits, rest'')
    _ -> Right (0, s3)
  let mantissa = read (intDigits ++ fracDigits) :: Integer
      e10 = expVal - fromIntegral (length fracDigits)
      signed = if neg then negate mantissa else mantissa
      rat =
        if e10 >= 0
          then fromInteger (signed * 10 ^ e10)
          else signed % (10 ^ negate e10)
      d = fromRational rat :: Double
  Right (JNum d, s4)
  where
    digits1 str = case span isDigit str of
      ("", _) -> Left "json: expected digits"
      (ds, rest) -> Right (ds, rest)
