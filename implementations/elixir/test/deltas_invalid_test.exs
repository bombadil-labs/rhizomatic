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
end
