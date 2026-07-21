defmodule DeltasInvalidTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Profile, Vectors}

  # l0-delta/deltas-invalid.json — every entry MUST be rejected at the
  # boundary, before canonical bytes exist. Reject, never repair.
  for vector <- Vectors.load!("l0-delta/deltas-invalid.json") do
    @vector vector
    test "#{@vector["name"]} is rejected (#{@vector["reason"]})" do
      assert {:error, _} = Profile.parse_claims(@vector["claims"])
    end
  end

  # The vector loop above only asserts THAT these are rejected. These pin WHY:
  # a fail-closed diagnosis that names the offending key or the ambiguity, not
  # an incidental error from some later stage (SPEC-1 §4.2 / ERRATA E19, #25).

  defp claims(target) do
    %{
      "timestamp" => 0,
      "author" => "did:key:zA",
      "pointers" => [%{"role" => "r", "target" => target}]
    }
  end

  describe "closed key sets (issue #25)" do
    test "an unknown claims key names the offender" do
      assert {:error, {:unknown_key, :claims, "version", nil}} =
               Profile.parse_claims(Map.put(claims("x"), "version", 2))
    end

    test "a misspelled claims key suggests the nearest known one" do
      assert {:error, {:unknown_key, :claims, "timestmp", "timestamp"}} =
               Profile.parse_claims(Map.put(claims("x"), "timestmp", 0))
    end

    test "an unknown pointer key is rejected" do
      c = %{claims("x") | "pointers" => [%{"role" => "r", "target" => "x", "weight" => 5}]}
      assert {:error, {:unknown_key, :pointer, "weight", nil}} = Profile.parse_claims(c)
    end

    test "a bytes literal has no context (D12)" do
      target = %{"mime" => "image/png", "value" => "iVBO", "context" => "c"}

      assert {:error, {:unknown_key, :bytes_target, "context", nil}} =
               Profile.parse_claims(claims(target))
    end
  end

  describe "target discrimination is exactly one of id | delta | mime" do
    test "id and delta together is ambiguous, not an entity ref" do
      assert {:error, {:ambiguous_target, ["id", "delta"]}} =
               Profile.parse_claims(claims(%{"id" => "e", "delta" => "1e2000"}))
    end

    test "id and mime together is ambiguous, not an entity ref" do
      target = %{"id" => "e", "mime" => "image/png", "value" => "iVBO"}

      assert {:error, {:ambiguous_target, ["id", "mime"]}} =
               Profile.parse_claims(claims(target))
    end

    test "exactly one discriminator still parses" do
      assert {:ok, _} = Profile.parse_claims(claims(%{"id" => "e", "context" => "c"}))
    end
  end
end
