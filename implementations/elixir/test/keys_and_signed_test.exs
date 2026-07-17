defmodule KeysAndSignedTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, Ed25519, Signer, Vectors}

  # keys/keys.json — public keys derive from the deterministic seeds
  for key <- Vectors.load!("keys/keys.json") do
    @key key
    test "#{@key["keyId"]}: public key derives from seed" do
      pub = Ed25519.public_key(Vectors.unhex(@key["seedHex"]))
      assert Vectors.hex(pub) == @key["publicKeyHex"]
      assert @key["author"] == "ed25519:" <> @key["publicKeyHex"]
    end
  end

  # l0-delta/deltas-signed.json — signature bytes must REPRODUCE exactly
  # (Ed25519 signing is deterministic), and verification must pass.
  for vector <- Vectors.load!("l0-delta/deltas-signed.json") do
    @vector vector
    test @vector["name"] do
      keys = Vectors.keys!()
      seed = Vectors.unhex(keys[@vector["keyId"]]["seedHex"])
      claims = Vectors.parse_claims!(@vector["claims"])

      assert Vectors.hex(Delta.canonical_bytes(claims)) == @vector["canonicalCborHex"]
      assert Delta.id_hex(claims) == @vector["id"]

      assert {:ok, sig_hex} = Signer.sign(claims, seed)
      assert sig_hex == @vector["sig"]

      assert Signer.verify(claims, @vector["sig"], @vector["id"])
    end
  end

  test "signing refuses claims whose author does not match the signing key" do
    keys = Vectors.keys!()
    seed = Vectors.unhex(keys["test-key-1"]["seedHex"])

    {:ok, claims} =
      Rhizomatic.Profile.parse_claims(%{
        "timestamp" => 0,
        "author" => keys["test-key-2"]["author"],
        "pointers" => [%{"role" => "x", "target" => "y"}]
      })

    assert {:error, :author_key_mismatch} = Signer.sign(claims, seed)
  end
end
