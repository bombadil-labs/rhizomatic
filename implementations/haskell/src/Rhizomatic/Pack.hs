{-# LANGUAGE OverloadedStrings #-}

-- | The SPEC-8 L0 pack: a byte-deterministic physical container for delta
-- sets. Build factors shared envelope metadata out of transaction members;
-- unpack rehydrates and runs the §4 fsck — every record must rebuild to
-- canonical bytes whose multihash equals its stored id, or the unpack errors.
--
-- Layout lore pinned by the vectors and #19 F2–F4: every record carries "i"
-- (its own id hex as a strings index); the strings table sorts by RAW UTF-8
-- byte order, not the encoded-CBOR-key order (the length head dominates the
-- latter — two different orders, never unify them); version rides as a float
-- (the profile has no integer encoding).
module Rhizomatic.Pack (PackedDelta (..), buildPack, unpackPack, packIdHex) where

import qualified Data.ByteString as B
import Data.List (elemIndex, sortOn)
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe, mapMaybe)
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Rhizomatic.Blake3 (blake3)
import Rhizomatic.Cbor (Item (..), decode, encode)
import Rhizomatic.Delta (Claims (..), Pointer (..), Target (..), deltaIdHex, validateClaims)
import Rhizomatic.Hex (encodeHex)

-- | A delta as it travels through a pack: claims plus optional signature hex.
data PackedDelta = PackedDelta {pdClaims :: Claims, pdSig :: Maybe T.Text} deriving (Eq, Show)

txnMember :: T.Text
txnMember = "rhizomatic.txn.member"

-- | SPEC-8 §3.1 (envelopes win, #19 F6): a delta is a manifest iff it carries
-- at least one pointer with role rhizomatic.txn.member AND a DeltaRef target.
isManifest :: Claims -> Bool
isManifest claims = not (null (memberRefs claims))

memberRefs :: Claims -> [T.Text]
memberRefs claims = [d | Pointer role (TDeltaRef d _) <- cPointers claims, role == txnMember]

-- Build -----------------------------------------------------------------------

buildPack :: [PackedDelta] -> Either String B.ByteString
buildPack deltas = do
  withIds0 <- mapM (\pd -> (,) pd <$> deltaIdHex (pdClaims pd)) deltas
  -- a delta set is a set: dedup by id (keep the first occurrence)
  let withIds = dedupOn snd withIds0
      envelopes = sortOn snd [x | x@(pd, _) <- withIds, isManifest (pdClaims pd)]
      envelopeIds = map snd envelopes
      -- member id -> index of the lexicographically first claiming manifest
      claimedBy =
        M.fromListWith min
          [ (T.unpack ref, mIdx)
            | (mIdx, (pd, _)) <- zip [0 :: Int ..] envelopes,
              ref <- memberRefs (pdClaims pd)
          ]
      members =
        sortOn snd
          [ x
            | x@(pd, idHex) <- withIds,
              not (isManifest (pdClaims pd)),
              M.member idHex claimedBy
          ]
      loose =
        sortOn snd
          [ x
            | x@(pd, idHex) <- withIds,
              not (isManifest (pdClaims pd)),
              not (M.member idHex claimedBy)
          ]
      envRecordOf (pd, idHex) = hydratedRecord pd idHex
      memberRecordOf (pd, idHex) =
        let mIdx = claimedBy M.! idHex
            (mPd, _) = envelopes !! mIdx
            mClaims = pdClaims mPd
            claims = pdClaims pd
            dt = cTimestamp claims - cTimestamp mClaims
         in ( [("i", SRef idHex), ("m", SNum (fromIntegral mIdx)), ("p", SPtrs (cPointers claims))]
                ++ [("a", SRef (T.unpack (cAuthor claims))) | cAuthor claims /= cAuthor mClaims]
                ++ [("dt", SNum dt) | dt /= 0]
                ++ [("s", SRef (T.unpack sig)) | Just sig <- [pdSig pd]]
            )
      envRecords = map envRecordOf envelopes
      memberRecords = map memberRecordOf members
      looseRecords = map envRecordOf loose
      -- the strings table: exactly the strings the records reference (#19 F4),
      -- sorted by raw UTF-8 byte order (#19 F3)
      allStrings =
        dedupOn id
          (concatMap recordStrings (envRecords ++ memberRecords ++ looseRecords))
      table = sortOn (TE.encodeUtf8 . T.pack) allStrings
      item =
        Map
          [ ("version", Num 1),
            ("strings", Arr (map (TStr . T.pack) table)),
            ("envelopes", Arr (map (recordToItem table) envRecords)),
            ("members", Arr (map (recordToItem table) memberRecords)),
            ("loose", Arr (map (recordToItem table) looseRecords))
          ]
  Right (encode item)

packIdHex :: B.ByteString -> String
packIdHex packBytes = encodeHex (B.pack [0x1e, 0x20] <> blake3 packBytes)

-- An abstract record field value, resolved against the strings table late so
-- the table can be collected from the records themselves.
data SVal = SRef String | SNum Double | SPtrs [Pointer]

hydratedRecord :: PackedDelta -> String -> [(T.Text, SVal)]
hydratedRecord pd idHex =
  let claims = pdClaims pd
   in [ ("a", SRef (T.unpack (cAuthor claims))),
        ("i", SRef idHex),
        ("t", SNum (cTimestamp claims)),
        ("p", SPtrs (cPointers claims))
      ]
        ++ [("s", SRef (T.unpack sig)) | Just sig <- [pdSig pd]]

recordStrings :: [(T.Text, SVal)] -> [String]
recordStrings = concatMap fieldStrings
  where
    fieldStrings (_, SRef s) = [s]
    fieldStrings (_, SNum _) = []
    fieldStrings (_, SPtrs ptrs) = concatMap ptrStrings ptrs
    ptrStrings (Pointer role target) =
      T.unpack role : case target of
        TEntity eid ctx -> T.unpack eid : ctxStrings ctx
        TDeltaRef dref ctx -> T.unpack dref : ctxStrings ctx
        TString s -> [T.unpack s]
        TNumber _ -> []
        TBool _ -> []
        TBytes mime _ -> [T.unpack mime]
    ctxStrings = maybe [] (\c -> [T.unpack c])

recordToItem :: [String] -> [(T.Text, SVal)] -> Item
recordToItem table fields = Map (map fieldToItem fields)
  where
    fieldToItem (key, val) = (key, valToItem val)
    valToItem (SRef s) = Num (idx s)
    valToItem (SNum n) = Num n
    valToItem (SPtrs ptrs) = Arr (map ptrToItem ptrs)
    ptrToItem (Pointer role target) =
      Map
        ( ("r", Num (idx (T.unpack role)))
            : case target of
              TEntity eid ctx -> ("e", Num (idx (T.unpack eid))) : ctxKv ctx
              TDeltaRef dref ctx -> ("d", Num (idx (T.unpack dref))) : ctxKv ctx
              TString s -> [("s", Num (idx (T.unpack s)))]
              TNumber n -> [("n", Num n)]
              TBool b -> [("b", Bool' b)]
              TBytes mime payload -> [("m", Num (idx (T.unpack mime))), ("y", BStr payload)]
        )
    ctxKv = maybe [] (\c -> [("c", Num (idx (T.unpack c)))])
    idx s = fromIntegral (fromMaybe (error ("pack: string not in table: " ++ s)) (elemIndex s table))

dedupOn :: Eq b => (a -> b) -> [a] -> [a]
dedupOn f = go []
  where
    go _ [] = []
    go seen (x : xs)
      | f x `elem` seen = go seen xs
      | otherwise = x : go (f x : seen) xs

-- Unpack ----------------------------------------------------------------------

-- | Decode pack bytes, rehydrate every record, and fsck: each rebuilt delta's
-- recomputed multihash MUST equal its stored id (SPEC-8 §4).
unpackPack :: B.ByteString -> Either String [PackedDelta]
unpackPack bytes = do
  item <- decode bytes
  top <- asMap "pack" item
  closedKeys' "pack" ["version", "strings", "envelopes", "members", "loose"] top
  version <- require "version" top
  case version of
    Num 1 -> Right ()
    _ -> Left "pack: unsupported version"
  table <- require "strings" top >>= asStrings
  envItems <- require "envelopes" top >>= asArr "envelopes"
  memberItems <- require "members" top >>= asArr "members"
  looseItems <- require "loose" top >>= asArr "loose"
  envelopes <- mapM (hydratedFromItem table) envItems
  members <- mapM (memberFromItem table envelopes) memberItems
  loose <- mapM (hydratedFromItem table) looseItems
  let everything = envelopes ++ members ++ loose
  mapM_ fsck everything
  Right (map fst everything)
  where
    fsck (pd, claimedId) = do
      validateClaims (pdClaims pd)
      idHex <- deltaIdHex (pdClaims pd)
      if idHex == claimedId
        then Right ()
        else Left ("pack: fsck failed — record id " ++ claimedId ++ " rehydrates to " ++ idHex)

hydratedFromItem :: [T.Text] -> Item -> Either String (PackedDelta, String)
hydratedFromItem table item = do
  fields <- asMap "record" item
  closedKeys' "record" ["a", "i", "t", "p", "s"] fields
  author <- require "a" fields >>= tableRef table
  idHex <- require "i" fields >>= tableRef table
  ts <- require "t" fields >>= asNum "t"
  ptrs <- require "p" fields >>= asArr "p" >>= mapM (ptrFromItem table)
  sig <- optionalRef table "s" fields
  Right (PackedDelta (Claims ts author ptrs) sig, T.unpack idHex)

memberFromItem :: [T.Text] -> [(PackedDelta, String)] -> Item -> Either String (PackedDelta, String)
memberFromItem table envelopes item = do
  fields <- asMap "member" item
  closedKeys' "member" ["m", "i", "p", "a", "dt", "s"] fields
  mIdxN <- require "m" fields >>= asNum "m"
  (envPd, _) <- indexInto "member envelope" envelopes mIdxN
  let mClaims = pdClaims envPd
  idHex <- require "i" fields >>= tableRef table
  ptrs <- require "p" fields >>= asArr "p" >>= mapM (ptrFromItem table)
  authorM <- optionalRef table "a" fields
  let author = fromMaybe (cAuthor mClaims) authorM
  dt <- case lookup "dt" fields of
    Nothing -> Right 0
    Just v -> asNum "dt" v
  sig <- optionalRef table "s" fields
  Right (PackedDelta (Claims (cTimestamp mClaims + dt) author ptrs) sig, T.unpack idHex)

ptrFromItem :: [T.Text] -> Item -> Either String Pointer
ptrFromItem table item = do
  fields <- asMap "ptr" item
  closedKeys' "ptr" ["r", "e", "d", "s", "n", "b", "m", "y", "c"] fields
  role <- require "r" fields >>= tableRef table
  ctx <- optionalRef table "c" fields
  let kinds = [k | k <- ["e", "d", "s", "n", "b", "y"], k `elem` map fst fields]
  target <- case kinds of
    ["e"] -> flip TEntity ctx <$> (require "e" fields >>= tableRef table)
    ["d"] -> flip TDeltaRef ctx <$> (require "d" fields >>= tableRef table)
    ["s"] -> do
      noContext ctx
      TString <$> (require "s" fields >>= tableRef table)
    ["n"] -> do
      noContext ctx
      TNumber <$> (require "n" fields >>= asNum "n")
    ["b"] -> do
      noContext ctx
      require "b" fields >>= \v -> case v of
        Bool' b -> Right (TBool b)
        _ -> Left "pack: b must be a bool"
    ["y"] -> do
      noContext ctx
      mime <- require "m" fields >>= tableRef table
      payload <- require "y" fields >>= \v -> case v of
        BStr bs -> Right bs
        _ -> Left "pack: y must be a byte string"
      Right (TBytes mime payload)
    _ -> Left "pack: ptr must carry exactly one target kind"
  Right (Pointer role target)
  where
    noContext Nothing = Right ()
    noContext (Just _) = Left "pack: a literal ptr carries no context"

-- helpers ---------------------------------------------------------------------

asMap :: String -> Item -> Either String [(T.Text, Item)]
asMap _ (Map kvs) = Right kvs
asMap what _ = Left ("pack: " ++ what ++ " must be a map")

asArr :: String -> Item -> Either String [Item]
asArr _ (Arr xs) = Right xs
asArr what _ = Left ("pack: " ++ what ++ " must be an array")

asNum :: String -> Item -> Either String Double
asNum _ (Num n) = Right n
asNum what _ = Left ("pack: " ++ what ++ " must be a number")

asStrings :: Item -> Either String [T.Text]
asStrings (Arr xs) = mapM (\x -> case x of TStr t -> Right t; _ -> Left "pack: strings must be text") xs
asStrings _ = Left "pack: strings must be an array"

require :: T.Text -> [(T.Text, Item)] -> Either String Item
require key fields = maybe (Left ("pack: missing key " ++ show key)) Right (lookup key fields)

optionalRef :: [T.Text] -> T.Text -> [(T.Text, Item)] -> Either String (Maybe T.Text)
optionalRef table key fields = case lookup key fields of
  Nothing -> Right Nothing
  Just v -> Just <$> tableRef table v

tableRef :: [T.Text] -> Item -> Either String T.Text
tableRef table (Num n) = snd <$> indexInto "strings" (map ((,) ()) table) n
tableRef _ _ = Left "pack: string index must be a number"

indexInto :: String -> [(a, b)] -> Double -> Either String (a, b)
indexInto what xs n =
  let i = truncate n :: Int
   in if fromIntegral i /= n || i < 0 || i >= length xs
        then Left ("pack: bad " ++ what ++ " index")
        else Right (xs !! i)

closedKeys' :: String -> [T.Text] -> [(T.Text, Item)] -> Either String ()
closedKeys' what allowed fields =
  case [k | (k, _) <- fields, k `notElem` allowed] of
    [] -> Right ()
    (k : _) -> Left ("pack: " ++ what ++ ": unknown key " ++ show k)
