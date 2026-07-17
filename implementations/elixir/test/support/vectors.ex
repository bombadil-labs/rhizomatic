defmodule Rhizomatic.Vectors do
  @moduledoc """
  Test-only loader for the shared conformance vectors at `../../vectors/`
  (the source of truth for correctness). JSON parsing uses Elixir's built-in
  `JSON` module; the float vectors themselves prove its number parsing is
  correctly rounded (see cbor_primitives_test).
  """

  @vectors_dir Path.expand("../../../../vectors", __DIR__)

  def load!(relpath) do
    @vectors_dir |> Path.join(relpath) |> File.read!() |> JSON.decode!()
  end

  def hex(bytes), do: Base.encode16(bytes, case: :lower)

  def unhex(hex), do: Base.decode16!(hex, case: :lower)

  @doc "Parse a vector's `claims` through the JSON debug profile, expecting success."
  def parse_claims!(claims_json) do
    {:ok, claims} = Rhizomatic.Profile.parse_claims(claims_json)
    claims
  end

  def keys!() do
    load!("keys/keys.json") |> Map.new(fn k -> {k["keyId"], k} end)
  end
end
