defmodule Rhizomatic.SetDigest do
  @moduledoc """
  The provisional D10 set digest (SPEC-1 ERRATA D10):

      digest(S) = contentAddress(canonical CBOR array of S's id strings,
                                 sorted lexicographically)

  A cheap canonical fingerprint of delta-set membership — NOT the SPEC-6 §4
  reconciliation digest. Gated as provisional.
  """

  alias Rhizomatic.{Cbor, Hash}

  @spec digest_hex([String.t()]) :: String.t()
  def digest_hex(id_hexes) do
    ids = id_hexes |> Enum.uniq() |> Enum.sort()
    Hash.id_hex(Cbor.encode({:arr, Enum.map(ids, &{:tstr, &1})}))
  end
end
