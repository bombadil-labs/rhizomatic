defmodule Rhizomatic.Profile do
  @moduledoc """
  The JSON debug profile parser (SPEC-1 §4.2) — the one blessed numeric
  coercion point (ERRATA D14): a JSON integer token is unambiguously a float
  spelling, so `42` and `42.0` parse to the same f64. Values not exactly
  representable as an f64 are rejected, never rounded.

  Input is JSON-decoded Elixir data (string-keyed maps, integers, floats,
  strings, booleans, nil, lists). Output is validated `Rhizomatic.Delta`
  claims.

  The profile is **closed** (SPEC-1 §4.2, ERRATA E19 / issue #25): every
  object node here declares the exact key set it recognizes, and any other
  key is rejected rather than ignored. Silently dropping a key a newer
  rhizomatic meant is repair (SPEC-4 §2), and repair is how two witnesses
  drift apart.

  A target object is discriminated structurally by exactly one of `id`
  (EntityRef), `delta` (DeltaRef), or `mime` (Bytes); a bare scalar is a
  primitive. Two or more discriminators is **ambiguous and rejected** — the
  older first-match-wins reading picked an arm and dropped the rest, which
  is the same repair by another name.
  """

  alias Rhizomatic.{Base64Url, Delta}

  import Bitwise

  @claims_keys ["timestamp", "author", "pointers"]
  @pointer_keys ["role", "target"]
  @entity_keys ["id", "context"]
  @delta_keys ["delta", "context"]
  # a bytes literal has no context (ERRATA D12)
  @bytes_keys ["mime", "value"]
  @target_discriminators ["id", "delta", "mime"]

  @spec parse_claims(term()) :: {:ok, Delta.claims()} | {:error, term()}
  def parse_claims(m) when is_map(m) do
    with :ok <- closed(m, @claims_keys, :claims),
         {:ok, ts} <- fetch(m, "timestamp", :claims),
         {:ok, author} <- fetch(m, "author", :claims),
         {:ok, raw_pointers} <- fetch(m, "pointers", :claims),
         {:ok, ts} <- coerce_number(ts, :timestamp),
         {:ok, pointers} <- parse_pointers(raw_pointers) do
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

  defp parse_pointer(p) when is_map(p) do
    with :ok <- closed(p, @pointer_keys, :pointer),
         {:ok, role} <- fetch(p, "role", :pointer),
         {:ok, target} <- fetch(p, "target", :pointer),
         {:ok, t} <- parse_target(target) do
      {:ok, %{role: role, target: t}}
    end
  end

  defp parse_pointer(_), do: {:error, :malformed_pointer}

  # -- target discrimination: EXACTLY one of id | delta | mime, or a bare scalar

  defp parse_target(m) when is_map(m) do
    case Enum.filter(@target_discriminators, &Map.has_key?(m, &1)) do
      [tag] -> parse_ref(tag, m)
      [] -> {:error, :target_object_not_a_ref}
      both -> {:error, {:ambiguous_target, both}}
    end
  end

  defp parse_target(s) when is_binary(s), do: {:ok, {:string, s}}
  defp parse_target(b) when is_boolean(b), do: {:ok, {:boolean, b}}

  defp parse_target(n) when is_integer(n) or is_float(n) do
    with {:ok, f} <- coerce_number(n, :target), do: {:ok, {:number, f}}
  end

  defp parse_target(_), do: {:error, :malformed_target}

  defp parse_ref("id", m) do
    with :ok <- closed(m, @entity_keys, :entity_ref),
         {:ok, id} <- fetch(m, "id", :entity_ref),
         {:ok, ctx} <- fetch_context(m) do
      {:ok, {:entity, id, ctx}}
    end
  end

  defp parse_ref("delta", m) do
    with :ok <- closed(m, @delta_keys, :delta_ref),
         {:ok, hex} <- fetch(m, "delta", :delta_ref),
         {:ok, ctx} <- fetch_context(m) do
      {:ok, {:delta, hex, ctx}}
    end
  end

  defp parse_ref("mime", m) do
    with :ok <- closed(m, @bytes_keys, :bytes_target),
         {:ok, mime} <- fetch(m, "mime", :bytes_target),
         {:ok, value} <- bytes_value(m),
         {:ok, payload} <- decode_b64u(value) do
      {:ok, {:bytes, mime, payload}}
    end
  end

  defp bytes_value(m) do
    case Map.fetch(m, "value") do
      {:ok, value} -> {:ok, value}
      :error -> {:error, :bytes_value_missing}
    end
  end

  # -- fail-closed key discipline (SPEC-1 §4.2 / SPEC-4 §2, issue #25)

  # Every key on a closed node must be one this version of the grammar knows.
  # Keys are sorted so the reported offender is deterministic, not map-order.
  defp closed(m, known, what) do
    case Enum.sort(Map.keys(m) -- known) do
      [] -> :ok
      [key | _] -> {:error, {:unknown_key, what, key, suggestion(key, known)}}
    end
  end

  # The nearest known key, when it is near enough to be a plausible typo;
  # otherwise nil, which reads as "version skew, not a misspelling".
  # `String.jaro_distance/2` keeps this dependency-free.
  defp suggestion(key, known) do
    known
    |> Enum.map(&{&1, String.jaro_distance(key, &1)})
    |> Enum.filter(fn {_, d} -> d >= 0.8 end)
    |> Enum.max_by(fn {_, d} -> d end, fn -> nil end)
    |> case do
      {best, _} -> best
      nil -> nil
    end
  end

  defp fetch(m, key, what) do
    case Map.fetch(m, key) do
      {:ok, v} -> {:ok, v}
      :error -> {:error, {:missing_key, what, key}}
    end
  end

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
