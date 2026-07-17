defmodule Rhizomatic.Signer do
  @moduledoc """
  Signing and verifying deltas (SPEC-1 §5).

  * `author` of a signed delta MUST be `"ed25519:" <> lowercase hex` of the
    32-byte public key; signing refuses claims whose author does not match
    the signing key (a signature that contradicts its own author field is
    born broken).
  * The signature is the detached deterministic Ed25519 signature over the
    **34 raw multihash bytes** of the delta's id.
  * Verification checks, in order: the id recomputes from the claims, then
    the signature verifies over the id bytes against the key named in
    `author`, under the §5.1 strict criterion.
  """

  alias Rhizomatic.{Delta, Ed25519}

  @author_prefix "ed25519:"

  @doc "Sign validated claims with the 32-byte seed; returns lowercase hex sig."
  @spec sign(Delta.claims(), binary()) :: {:ok, String.t()} | {:error, term()}
  def sign(claims, <<seed::binary-32>>) do
    pub_hex = Base.encode16(Ed25519.public_key(seed), case: :lower)

    if claims.author == @author_prefix <> pub_hex do
      {:ok, Base.encode16(Ed25519.sign(Delta.id_bytes(claims), seed), case: :lower)}
    else
      {:error, :author_key_mismatch}
    end
  end

  @doc """
  Verify a signed delta: validated claims + lowercase-hex signature, against
  the key named in `author`. Optionally checks the claims recompute to
  `expected_id_hex` first (the id-recomputes half of §5's verification).
  """
  @spec verify(Delta.claims(), String.t(), String.t() | nil) :: boolean()
  def verify(claims, sig_hex, expected_id_hex \\ nil) do
    with @author_prefix <> pub_hex <- claims.author,
         {:ok, pub} <- decode_hex_32(pub_hex),
         {:ok, sig} <- decode_hex_64(sig_hex) do
      id_bytes = Delta.id_bytes(claims)
      id_hex = Base.encode16(id_bytes, case: :lower)

      (expected_id_hex == nil or id_hex == expected_id_hex) and
        Ed25519.verify_strict(sig, id_bytes, pub)
    else
      _ -> false
    end
  end

  defp decode_hex_32(hex) do
    case lower_hex_decode(hex) do
      {:ok, <<b::binary-32>>} -> {:ok, b}
      _ -> :error
    end
  end

  defp decode_hex_64(hex) do
    case lower_hex_decode(hex) do
      {:ok, <<b::binary-64>>} -> {:ok, b}
      _ -> :error
    end
  end

  defp lower_hex_decode(hex) when is_binary(hex), do: Base.decode16(hex, case: :lower)
  defp lower_hex_decode(_), do: :error
end
