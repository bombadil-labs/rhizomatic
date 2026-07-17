defmodule Rhizomatic.Delta do
  @moduledoc """
  The delta (SPEC-1): claims validation at the boundary (reject, never
  repair), canonical serialization (§4.1), and content addressing.

  In-memory claims form (all boundary-validated):

      %{
        timestamp: float(),           # finite f64; a native integer is REJECTED (D14)
        author: String.t(),           # non-empty, NFC
        pointers: [pointer]           # at least one
      }

      pointer :: %{role: String.t(), target: target}
      target ::
          {:string, String.t()}
        | {:number, float()}
        | {:boolean, boolean()}
        | {:entity, id :: String.t(), context :: String.t() | nil}
        | {:delta, hex :: String.t(), context :: String.t() | nil}
        | {:bytes, mime :: String.t(), payload :: binary()}

  The host-boundary numeric policy (SPEC-1 §4.1 / ERRATA D14): on the BEAM,
  `42` and `42.0` are distinct terms, so claim construction rejects native
  integers everywhere a number is expected. The one blessed coercion point is
  the JSON debug profile parser (`Rhizomatic.Profile`), where an integer
  token is unambiguously a float spelling.
  """

  alias Rhizomatic.{Cbor, Hash}

  @type target ::
          {:string, String.t()}
          | {:number, float()}
          | {:boolean, boolean()}
          | {:entity, String.t(), String.t() | nil}
          | {:delta, String.t(), String.t() | nil}
          | {:bytes, String.t(), binary()}

  @type pointer :: %{role: String.t(), target: target()}
  @type claims :: %{timestamp: float(), author: String.t(), pointers: [pointer()]}

  # ------------------------------------------------------------- validation

  @doc """
  Validate claims at the boundary. Returns `{:ok, claims}` or
  `{:error, reason}`. Reject, never repair (SPEC-4 §2).
  """
  @spec validate(term()) :: {:ok, claims()} | {:error, term()}
  def validate(%{timestamp: ts, author: author, pointers: pointers} = claims)
      when map_size(claims) == 3 do
    with :ok <- validate_timestamp(ts),
         :ok <- validate_nonempty_nfc(author, :author),
         :ok <- validate_pointers(pointers) do
      {:ok, %{timestamp: ts, author: author, pointers: pointers}}
    end
  end

  def validate(_), do: {:error, :malformed_claims}

  defp validate_timestamp(ts) when is_float(ts) do
    # NaN/Infinity are not representable as Elixir floats; finiteness holds
    :ok
  end

  defp validate_timestamp(ts) when is_integer(ts), do: {:error, {:native_integer, :timestamp}}
  defp validate_timestamp(_), do: {:error, :timestamp_not_a_number}

  defp validate_pointers(pointers) when is_list(pointers) and pointers != [] do
    Enum.reduce_while(pointers, :ok, fn p, :ok ->
      case validate_pointer(p) do
        :ok -> {:cont, :ok}
        {:error, e} -> {:halt, {:error, e}}
      end
    end)
  end

  defp validate_pointers([]), do: {:error, :pointers_empty}
  defp validate_pointers(_), do: {:error, :pointers_not_a_list}

  defp validate_pointer(%{role: role, target: target} = p) when map_size(p) == 2 do
    with :ok <- validate_nonempty_nfc(role, :role), do: validate_target(target)
  end

  defp validate_pointer(_), do: {:error, :malformed_pointer}

  defp validate_target({:string, s}), do: validate_nfc(s, :string_primitive)
  defp validate_target({:number, f}) when is_float(f), do: :ok
  defp validate_target({:number, i}) when is_integer(i), do: {:error, {:native_integer, :target}}
  defp validate_target({:boolean, b}) when is_boolean(b), do: :ok

  defp validate_target({:entity, id, context}) do
    with :ok <- validate_nonempty_nfc(id, :entity_id), do: validate_context(context)
  end

  defp validate_target({:delta, hex, context}) do
    with :ok <- validate_nonempty_nfc(hex, :delta_ref), do: validate_context(context)
  end

  defp validate_target({:bytes, mime, payload}) do
    cond do
      not is_binary(payload) -> {:error, :bytes_value_not_binary}
      true -> validate_nonempty_nfc(mime, :mime)
    end
  end

  defp validate_target(_), do: {:error, :malformed_target}

  defp validate_context(nil), do: :ok
  defp validate_context(c), do: validate_nonempty_nfc(c, :context)

  defp validate_nonempty_nfc(s, field) do
    cond do
      not is_binary(s) -> {:error, {:not_a_string, field}}
      s == "" -> {:error, {:empty_string, field}}
      true -> validate_nfc(s, field)
    end
  end

  # NFC is validated at the boundary, never repaired (SPEC-1 §4.1 / D11)
  defp validate_nfc(s, field) do
    cond do
      not is_binary(s) or not String.valid?(s) -> {:error, {:not_a_string, field}}
      :unicode.characters_to_nfc_binary(s) != s -> {:error, {:not_nfc, field}}
      true -> :ok
    end
  end

  # --------------------------------------------------------- canonical form

  @doc "Canonical deterministic-CBOR bytes of validated claims (SPEC-1 §4.1)."
  @spec canonical_bytes(claims()) :: binary()
  def canonical_bytes(claims) do
    Cbor.encode(to_cbor(claims))
  end

  @doc "Lowercase-hex multihash id of validated claims."
  @spec id_hex(claims()) :: String.t()
  def id_hex(claims), do: Hash.id_hex(canonical_bytes(claims))

  @doc "34 raw multihash bytes of the id (the Ed25519 signing message, §5)."
  @spec id_bytes(claims()) :: binary()
  def id_bytes(claims), do: Hash.content_address(canonical_bytes(claims))

  @doc false
  @spec to_cbor(claims()) :: Cbor.t()
  def to_cbor(%{timestamp: ts, author: author, pointers: pointers}) do
    {:map,
     [
       {{:tstr, "author"}, {:tstr, author}},
       {{:tstr, "pointers"}, {:arr, Enum.map(pointers, &pointer_to_cbor/1)}},
       {{:tstr, "timestamp"}, {:float, ts}}
     ]}
  end

  defp pointer_to_cbor(%{role: role, target: target}) do
    {:map,
     [
       {{:tstr, "role"}, {:tstr, role}},
       {{:tstr, "target"}, target_to_cbor(target)}
     ]}
  end

  defp target_to_cbor({:string, s}), do: {:tstr, s}
  defp target_to_cbor({:number, f}), do: {:float, f}
  defp target_to_cbor({:boolean, b}), do: {:bool, b}

  defp target_to_cbor({:entity, id, context}),
    do: {:map, [{{:tstr, "id"}, {:tstr, id}} | context_pair(context)]}

  defp target_to_cbor({:delta, hex, context}),
    do: {:map, [{{:tstr, "delta"}, {:tstr, hex}} | context_pair(context)]}

  defp target_to_cbor({:bytes, mime, payload}),
    do: {:map, [{{:tstr, "mime"}, {:tstr, mime}}, {{:tstr, "value"}, {:bstr, payload}}]}

  defp context_pair(nil), do: []
  defp context_pair(c), do: [{{:tstr, "context"}, {:tstr, c}}]
end
