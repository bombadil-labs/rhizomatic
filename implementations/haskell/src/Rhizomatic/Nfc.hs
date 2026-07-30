-- | NFC validation (SPEC-1 §4.1: validated at the boundary, never repaired):
-- @isNfc t@ answers whether @t@ is already in Normalization Form C, by full
-- normalize-and-compare (UAX #15 canonical decomposition → canonical ordering
-- → canonical composition, with algorithmic Hangul). Tables come from
-- 'Rhizomatic.UnicodeTables' (generated; see ERRATA D15 on whose tables answer
-- the question — this witness pins its own, provenance in the table header).
module Rhizomatic.Nfc (isNfc, nfc) where

import qualified Data.IntMap.Strict as IM
import qualified Data.Map.Strict as M
import qualified Data.Text as T
import Rhizomatic.UnicodeTables (cccRanges, decompositions, primaryComposites)

isNfc :: T.Text -> Bool
isNfc t = nfc t == t

nfc :: T.Text -> T.Text
nfc = T.pack . map toEnum . compose . reorder . concatMap decompose . map fromEnum . T.unpack

-- Canonical combining class ------------------------------------------------

cccMap :: IM.IntMap Int
cccMap = IM.fromList [(cp, c) | (lo, hi, c) <- cccRanges, cp <- [lo .. hi]]

ccc :: Int -> Int
ccc cp = IM.findWithDefault 0 cp cccMap

-- Decomposition -------------------------------------------------------------

decompMap :: IM.IntMap [Int]
decompMap = IM.fromList decompositions

-- Hangul constants (UAX #15 §3.12)
sBase, lBase, vBase, tBase, lCount, vCount, tCount, nCount, sCount :: Int
sBase = 0xAC00
lBase = 0x1100
vBase = 0x1161
tBase = 0x11A7
lCount = 19
vCount = 21
tCount = 28
nCount = vCount * tCount
sCount = lCount * nCount

-- | Full (recursive) canonical decomposition of one code point.
decompose :: Int -> [Int]
decompose cp
  | cp >= sBase && cp < sBase + sCount =
      let sIndex = cp - sBase
          l = lBase + sIndex `div` nCount
          v = vBase + (sIndex `mod` nCount) `div` tCount
          t = tBase + sIndex `mod` tCount
       in if t == tBase then [l, v] else [l, v, t]
  | otherwise = case IM.lookup cp decompMap of
      Nothing -> [cp]
      Just parts -> concatMap decompose parts

-- Canonical ordering (stable sort of nonzero-ccc runs) -----------------------

reorder :: [Int] -> [Int]
reorder [] = []
reorder cps =
  let (marks, rest) = span (\c -> ccc c > 0) cps
   in case marks of
        [] -> head cps : reorder (tail cps)
        _ -> stableSortByCcc marks ++ reorder rest

stableSortByCcc :: [Int] -> [Int]
stableSortByCcc = map snd . sortOnFst . zipWith (\i c -> ((ccc c, i :: Int), c)) [0 ..]
  where
    sortOnFst = foldr insert []
    insert x [] = [x]
    insert x (y : ys)
      | fst x <= fst y = x : y : ys
      | otherwise = y : insert x ys

-- Composition ----------------------------------------------------------------

compMap :: M.Map (Int, Int) Int
compMap = M.fromList [((a, b), x) | (a, b, x) <- primaryComposites]

composePair :: Int -> Int -> Maybe Int
composePair a b
  -- Hangul L+V and LV+T (algorithmic)
  | a >= lBase && a < lBase + lCount && b >= vBase && b < vBase + vCount =
      Just (sBase + ((a - lBase) * vCount + (b - vBase)) * tCount)
  | a >= sBase && a < sBase + sCount && (a - sBase) `mod` tCount == 0 && b > tBase && b < tBase + tCount =
      Just (a + (b - tBase))
  | otherwise = M.lookup (a, b) compMap

-- | UAX #15 canonical composition over a canonically-ordered sequence.
compose :: [Int] -> [Int]
compose [] = []
compose (first : rest)
  | ccc first /= 0 = first : compose rest -- leading non-starter: nothing to anchor to
  | otherwise = go first [] rest
  where
    -- starter: the last starter; pending: reversed marks after it (kept ones)
    go starter pending (c : cs) =
      let blocked = case pending of
            [] -> False
            (p : _) -> ccc p >= ccc c
       in if not blocked
            then case composePair starter c of
              Just x -> go x pending cs
              Nothing ->
                if ccc c == 0
                  then starter : reverse pending ++ compose (c : cs)
                  else go starter (c : pending) cs
            else
              if ccc c == 0
                then starter : reverse pending ++ compose (c : cs)
                else go starter (c : pending) cs
    go starter pending [] = starter : reverse pending
