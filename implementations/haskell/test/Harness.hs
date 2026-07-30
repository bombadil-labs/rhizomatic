-- | Minimal test harness: no framework dependency, exit nonzero on any failure.
module Harness (Test, ok, failure, expect, expectEq, runSuites, loadVectors) where

import Control.Monad (unless)
import qualified Data.ByteString as B
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Rhizomatic.Json (JValue (..), parseJson)
import System.Exit (exitFailure)
import System.IO (hPutStrLn, stderr)

-- | A named check: Left is a failure message.
type Test = (String, Either String ())

ok :: String -> Test
ok name = (name, Right ())

failure :: String -> String -> Test
failure name msg = (name, Left msg)

expect :: String -> Bool -> String -> Test
expect name cond msg = (name, if cond then Right () else Left msg)

expectEq :: (Eq a, Show a) => String -> a -> a -> Test
expectEq name got want =
  ( name,
    if got == want
      then Right ()
      else Left ("expected " ++ show want ++ "\n       got " ++ show got)
  )

runSuites :: [(String, IO [Test])] -> IO ()
runSuites suites = do
  failures <- concat <$> mapM runSuite suites
  unless (null failures) $ do
    hPutStrLn stderr (show (length failures) ++ " failure(s)")
    exitFailure
  where
    runSuite (label, action) = do
      tests <- action
      let bad = [(n, m) | (n, Left m) <- tests]
      putStrLn (label ++ ": " ++ show (length tests - length bad) ++ "/" ++ show (length tests))
      mapM_ (\(n, m) -> hPutStrLn stderr ("  FAIL " ++ n ++ ": " ++ m)) bad
      pure [label ++ "/" ++ n | (n, _) <- bad]

-- | Load a vector file from ../../vectors (the witness runs from its own root).
loadVectors :: FilePath -> IO JValue
loadVectors rel = do
  raw <- B.readFile ("../../vectors/" ++ rel)
  case parseJson (T.unpack (TE.decodeUtf8 raw)) of
    Left err -> Prelude.error ("cannot parse " ++ rel ++ ": " ++ err)
    Right v -> pure v
