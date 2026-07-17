defmodule DeltasBytesTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, Vectors}

  # l0-delta/deltas-bytes.json — the bytes target kind (ERRATA D12).
  for vector <- Vectors.load!("l0-delta/deltas-bytes.json") do
    @vector vector
    test @vector["name"] do
      claims = Vectors.parse_claims!(@vector["claims"])
      assert Vectors.hex(Delta.canonical_bytes(claims)) == @vector["canonicalCborHex"]
      assert Delta.id_hex(claims) == @vector["id"]
    end
  end
end
