defmodule SetDigestTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, SetDigest, Vectors}

  # l0-delta/set-digest.json — the provisional D10 membership digest of the
  # deltas.json set.
  test "digest of the deltas.json set matches the pinned digest" do
    vector = Vectors.load!("l0-delta/set-digest.json")

    computed_ids =
      Vectors.load!("l0-delta/deltas.json")
      |> Enum.map(fn v -> v["claims"] |> Vectors.parse_claims!() |> Delta.id_hex() end)
      |> Enum.sort()

    assert computed_ids == vector["ids"]
    assert SetDigest.digest_hex(computed_ids) == vector["digest"]
  end

  test "digest is order-independent and deduplicating (set semantics)" do
    vector = Vectors.load!("l0-delta/set-digest.json")
    shuffled = Enum.reverse(vector["ids"]) ++ Enum.take(vector["ids"], 3)
    assert SetDigest.digest_hex(shuffled) == vector["digest"]
  end
end
