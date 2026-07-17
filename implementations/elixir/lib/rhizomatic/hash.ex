defmodule Rhizomatic.Hash do
  @moduledoc """
  Content addressing (SPEC-1 §4.1): BLAKE3-256 wrapped as a multihash.

      id = 0x1e ++ 0x20 ++ blake3_256(bytes)    (34 raw bytes)

  At boundaries the id is its lowercase hex spelling: `"1e20" <> hex(digest)`.
  """

  @doc "34 raw multihash bytes of the BLAKE3-256 of `bytes`."
  @spec content_address(binary()) :: binary()
  def content_address(bytes) do
    <<0x1E, 0x20, Rhizomatic.Blake3.hash(bytes)::binary>>
  end

  @doc "Lowercase hex multihash id of `bytes`."
  @spec id_hex(binary()) :: String.t()
  def id_hex(bytes), do: Base.encode16(content_address(bytes), case: :lower)
end
