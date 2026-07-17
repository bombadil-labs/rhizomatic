defmodule Rhizomatic.Base64Url do
  @moduledoc """
  Canonical base64url (RFC 4648 §5, unpadded) — the JSON debug profile's
  transport for byte payloads (SPEC-1 §4.2 / ERRATA D12).

  Canonical means: no `=` padding, alphabet strictly `A–Z a–z 0–9 - _`,
  length never ≡ 1 (mod 4), and the final character's unused low bits zero.
  Decoding validates all of it; violations are rejected, never repaired.
  """

  @spec decode(String.t()) :: {:ok, binary()} | {:error, term()}
  def decode(s) when is_binary(s) do
    cond do
      not valid_alphabet?(s) ->
        {:error, :bad_alphabet}

      rem(byte_size(s), 4) == 1 ->
        {:error, :bad_length}

      true ->
        case Base.url_decode64(s, padding: false) do
          {:ok, bytes} ->
            # non-canonical trailing bits survive lax decoders; the canonical
            # spelling of the bytes must reproduce the input exactly
            if encode(bytes) == s, do: {:ok, bytes}, else: {:error, :noncanonical_trailing_bits}

          :error ->
            {:error, :invalid_base64url}
        end
    end
  end

  def decode(_), do: {:error, :not_a_string}

  @spec encode(binary()) :: String.t()
  def encode(bytes), do: Base.url_encode64(bytes, padding: false)

  defp valid_alphabet?(s) do
    s |> :binary.bin_to_list() |> Enum.all?(&alphabet_byte?/1)
  end

  defp alphabet_byte?(c) do
    c in ?A..?Z or c in ?a..?z or c in ?0..?9 or c == ?- or c == ?_
  end
end
