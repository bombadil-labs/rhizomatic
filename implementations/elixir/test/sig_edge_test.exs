defmodule SigEdgeTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, Signer, Vectors}

  # l0-delta/deltas-sig-edge.json — the SPEC-1 §5.1 strict acceptance
  # criterion, clause by clause. Never a library's default verifier.
  for vector <- Vectors.load!("l0-delta/deltas-sig-edge.json") do
    @vector vector
    test "#{@vector["name"]} -> #{@vector["verdict"]}" do
      claims = Vectors.parse_claims!(@vector["claims"])
      assert Delta.id_hex(claims) == @vector["id"]

      expected = @vector["verdict"] == "verified"
      assert Signer.verify(claims, @vector["sig"], @vector["id"]) == expected
    end
  end
end
