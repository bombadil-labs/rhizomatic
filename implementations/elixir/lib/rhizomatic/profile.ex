defmodule Rhizomatic.Profile do
  @moduledoc """
  The JSON debug profile parser (SPEC-1 §4.2) — the one blessed numeric
  coercion point (ERRATA D14): a JSON integer token is unambiguously a float
  spelling, so `42` and `42.0` parse to the same f64. Values not exactly
  representable as an f64 are rejected, never rounded.

  Input is JSON-decoded Elixir data (string-keyed maps, integers, floats,
  strings, booleans, nil, lists). Output is validated `Rhizomatic.Delta`
  claims. Targets are discriminated structurally, first match wins:
  `id` → EntityRef, `delta` → DeltaRef, else `mime` → Bytes, else a bare
  scalar.
  """

  alias Rhizomatic.{Base64Url, Delta}

  import Bitwise

  @spec parse_claims(term()) :: {:ok, Delta.claims()} | {:error, term()}
  def parse_claims(%{"timestamp" => ts, "author" => author, "pointers" => pointers} = m)
      when map_size(m) == 3 do
    with {:ok, ts} <- coerce_number(ts, :timestamp),
         {:ok, pointers} <- parse_pointers(pointers) do
      Delta.validate(%{timestamp: ts, author: author, pointers: pointers})
    end
  end

  def parse_claims(_), do: {:error, :malformed_claims}

  defp parse_pointers(pointers) when is_list(pointers) do
    pointers
    |> Enum.reduce_while({:ok, []}, fn p, {:ok, acc} ->
      case parse_pointer(p) do
        {:ok, parsed} -> {:cont, {:ok, [parsed | acc]}}
        {:error, e} -> {:halt, {:error, e}}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      err -> err
    end
  end

  defp parse_pointers(_), do: {:error, :pointers_not_a_list}

  defp parse_pointer(%{"role" => role, "target" => target} = p) when map_size(p) == 2 do
    with {:ok, t} <- parse_target(target), do: {:ok, %{role: role, target: t}}
  end

  defp parse_pointer(_), do: {:error, :malformed_pointer}

  # -- target discrimination (first match wins: id, delta, mime, bare scalar)

  defp parse_target(%{"id" => id} = m) do
    with [] <- Map.keys(m) -- ["id", "context"],
         {:ok, ctx} <- fetch_context(m) do
      {:ok, {:entity, id, ctx}}
    else
      {:error, e} -> {:error, e}
      extra when is_list(extra) -> {:error, {:unknown_keys, extra}}
    end
  end

  defp parse_target(%{"delta" => hex} = m) do
    with [] <- Map.keys(m) -- ["delta", "context"],
         {:ok, ctx} <- fetch_context(m) do
      {:ok, {:delta, hex, ctx}}
    else
      {:error, e} -> {:error, e}
      extra when is_list(extra) -> {:error, {:unknown_keys, extra}}
    end
  end

  defp parse_target(%{"mime" => mime} = m) do
    with [] <- Map.keys(m) -- ["mime", "value"],
         true <- Map.has_key?(m, "value") || {:error, :bytes_value_missing},
         {:ok, payload} <- decode_b64u(Map.fetch!(m, "value")) do
      {:ok, {:bytes, mime, payload}}
    else
      {:error, e} -> {:error, e}
      extra when is_list(extra) -> {:error, {:unknown_keys, extra}}
    end
  end

  defp parse_target(m) when is_map(m), do: {:error, :target_object_not_a_ref}
  defp parse_target(s) when is_binary(s), do: {:ok, {:string, s}}
  defp parse_target(b) when is_boolean(b), do: {:ok, {:boolean, b}}

  defp parse_target(n) when is_integer(n) or is_float(n) do
    with {:ok, f} <- coerce_number(n, :target), do: {:ok, {:number, f}}
  end

  defp parse_target(_), do: {:error, :malformed_target}

  # an explicit null context is present-but-malformed, not absent
  defp fetch_context(m) do
    case Map.fetch(m, "context") do
      :error -> {:ok, nil}
      {:ok, nil} -> {:error, :context_null}
      {:ok, ctx} -> {:ok, ctx}
    end
  end

  defp decode_b64u(v) when is_binary(v), do: Base64Url.decode(v)
  defp decode_b64u(_), do: {:error, :bytes_value_not_a_string}

  # -- the blessed coercion point: JSON integer token -> f64, iff exact

  defp coerce_number(f, _field) when is_float(f), do: {:ok, f}

  defp coerce_number(i, field) when is_integer(i) do
    if abs(i) <= 1 <<< 53 do
      {:ok, 1.0 * i}
    else
      try do
        f = 1.0 * i
        if trunc(f) == i, do: {:ok, f}, else: {:error, {:not_exact_f64, field}}
      rescue
        ArithmeticError -> {:error, {:not_exact_f64, field}}
      end
    end
  end

  defp coerce_number(_, field), do: {:error, {:not_a_number, field}}
end
