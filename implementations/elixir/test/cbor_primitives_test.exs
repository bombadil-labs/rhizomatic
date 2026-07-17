defmodule CborPrimitivesTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Cbor, Vectors}

  # l0-delta/cbor-primitives.json — hand-verified scalar ground truth.
  # Every hex must be byte-exact; everything stacks on this encoder.
  for {vector, i} <- Enum.with_index(Vectors.load!("l0-delta/cbor-primitives.json")) do
    # build the AST at test-generation time (JSON integers coerce as in the
    # debug profile: they are float spellings)
    ast =
      case {vector["kind"], vector["value"]} do
        {"float", v} -> {:float, v * 1.0}
        {"tstr", v} -> {:tstr, v}
        {"bool", v} -> {:bool, v}
        {"bstr", v} -> {:bstr, Base.decode16!(v, case: :lower)}
      end

    @vector vector
    @ast ast
    test "#{i}: #{vector["name"]}" do
      assert Vectors.hex(Cbor.encode(@ast)) == @vector["hex"]

      # and the profile decoder round-trips it
      assert {:ok, decoded} = Cbor.decode_exact(Vectors.unhex(@vector["hex"]))
      assert Cbor.encode(decoded) == Cbor.encode(@ast)
    end
  end

  test "JSON number parsing is correctly rounded (float-f16-min-subnormal is exactly 2^-24)" do
    v =
      Vectors.load!("l0-delta/cbor-primitives.json")
      |> Enum.find(&(&1["name"] == "float-f16-min-subnormal"))

    assert v["value"] == :math.pow(2, -24)
  end

  test "-0.0 normalizes to +0.0 before encoding" do
    assert Vectors.hex(Cbor.encode({:float, -0.0})) == "f90000"
  end
end
