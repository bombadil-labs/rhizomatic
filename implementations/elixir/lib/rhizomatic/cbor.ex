defmodule Rhizomatic.Cbor do
  @moduledoc """
  Canonical deterministic CBOR (RFC 8949 §4.2.1), specialized by the
  Rhizomatic profile (SPEC-1 §4.1):

    * numbers are floats only (major type 7) — integer major types are never
      emitted; `-0.0` normalizes to `+0.0`;
    * the shortest-form float rule is full §4.2.1: the shortest of
      f16 / f32 / f64 that represents the value exactly, including f16
      subnormals down to 2^-24;
    * definite lengths everywhere; indefinite lengths are forbidden;
    * map keys sort by the bytewise lexicographic order of their *encoded*
      key bytes;
    * text strings are definite-length UTF-8 (NFC validation happens at the
      claims boundary, not here); byte strings are definite-length with the
      same shortest length head.

  Values are an explicit tagged AST so text/bytes/floats can never be
  confused on the BEAM:

      {:tstr, binary} | {:bstr, binary} | {:float, float} | {:bool, boolean}
      | {:arr, [value]} | {:map, [{key :: value, value}]}
  """

  import Bitwise

  @type t ::
          {:tstr, binary()}
          | {:bstr, binary()}
          | {:float, float()}
          | {:bool, boolean()}
          | {:arr, [t()]}
          | {:map, [{t(), t()}]}

  # ---------------------------------------------------------------- encoding

  @spec encode(t()) :: binary()
  def encode({:tstr, s}) when is_binary(s) do
    <<head(3, byte_size(s))::binary, s::binary>>
  end

  def encode({:bstr, b}) when is_binary(b) do
    <<head(2, byte_size(b))::binary, b::binary>>
  end

  def encode({:bool, true}), do: <<0xF5>>
  def encode({:bool, false}), do: <<0xF4>>

  def encode({:float, f}) when is_float(f), do: encode_float(f)

  def encode({:arr, items}) when is_list(items) do
    IO.iodata_to_binary([head(4, length(items)) | Enum.map(items, &encode/1)])
  end

  def encode({:map, pairs}) when is_list(pairs) do
    encoded =
      pairs
      |> Enum.map(fn {k, v} -> {encode(k), encode(v)} end)
      |> Enum.sort_by(fn {ek, _} -> ek end)

    IO.iodata_to_binary([
      head(5, length(encoded))
      | Enum.map(encoded, fn {ek, ev} -> [ek, ev] end)
    ])
  end

  # shortest-form length / count head for a major type
  defp head(major, n) when n >= 0 do
    mt = major <<< 5

    cond do
      n < 24 -> <<mt ||| n>>
      n < 0x100 -> <<mt ||| 24, n>>
      n < 0x10000 -> <<mt ||| 25, n::16>>
      n < 0x100000000 -> <<mt ||| 26, n::32>>
      true -> <<mt ||| 27, n::64>>
    end
  end

  # ------------------------------------------------------------ float ladder

  # Encode a finite f64 in the shortest of f16 / f32 / f64 that represents it
  # exactly. NaN / ±Infinity never reach this point (rejected at the claims
  # boundary), so only finite values are handled.
  defp encode_float(f) do
    # -0.0 normalizes to +0.0 before encoding (SPEC-1 §4.1)
    f = if f == 0.0, do: 0.0, else: f

    case f16_bits(f) do
      {:ok, b16} ->
        <<0xF9, b16::16>>

      :error ->
        case f32_bits(f) do
          {:ok, b32} -> <<0xFA, b32::32>>
          :error -> <<0xFB, f::float-64>>
        end
    end
  end

  # Exact float16 representation of a finite f64, if one exists.
  # Hand-rolled from the f64 bit pattern: the BEAM has no native f16 use we
  # want to depend on for canonical bytes.
  @doc false
  @spec f16_bits(float()) :: {:ok, non_neg_integer()} | :error
  def f16_bits(f) do
    <<s::1, e::11, m::52>> = <<f::float-64>>

    cond do
      e == 0 and m == 0 ->
        # ±0.0 (already normalized to +0.0 upstream, but stay total)
        {:ok, s <<< 15}

      e == 0 ->
        # f64 subnormals are ~2^-1022, far below f16 range
        :error

      true ->
        exp = e - 1023

        cond do
          exp >= -14 and exp <= 15 ->
            # normal f16 candidate: mantissa must fit in 10 bits
            if (m &&& (1 <<< 42) - 1) == 0 do
              {:ok, s <<< 15 ||| (exp + 15) <<< 10 ||| m >>> 42}
            else
              :error
            end

          exp >= -24 and exp < -14 ->
            # subnormal f16 candidate: value must be an integer multiple of
            # 2^-24 with significand < 2^10.
            # value = (2^52 + m) * 2^(exp - 52); value / 2^-24 = (2^52+m) >> (28 - exp)
            shift = 28 - exp

            if shift <= 52 and (m &&& (1 <<< shift) - 1) == 0 do
              sig = (1 <<< 52 ||| m) >>> shift
              if sig >= 1 and sig < 1024, do: {:ok, s <<< 15 ||| sig}, else: :error
            else
              :error
            end

          true ->
            :error
        end
    end
  end

  # Exact float32 representation of a finite f64, if one exists.
  @doc false
  @spec f32_bits(float()) :: {:ok, non_neg_integer()} | :error
  def f32_bits(f) do
    <<s::1, e::11, m::52>> = <<f::float-64>>

    cond do
      e == 0 and m == 0 ->
        {:ok, s <<< 31}

      e == 0 ->
        :error

      true ->
        exp = e - 1023

        cond do
          exp >= -126 and exp <= 127 ->
            if (m &&& (1 <<< 29) - 1) == 0 do
              {:ok, s <<< 31 ||| (exp + 127) <<< 23 ||| m >>> 29}
            else
              :error
            end

          exp >= -149 and exp < -126 ->
            # subnormal f32: value / 2^-149 = (2^52+m) >> (52 - (exp + 149))
            shift = 52 - (exp + 149)

            if shift <= 52 and (m &&& (1 <<< shift) - 1) == 0 do
              sig = (1 <<< 52 ||| m) >>> shift
              if sig >= 1 and sig < 1 <<< 23, do: {:ok, s <<< 31 ||| sig}, else: :error
            else
              :error
            end

          true ->
            :error
        end
    end
  end

  # ---------------------------------------------------------------- decoding

  @doc """
  Decode one canonical CBOR item, returning `{:ok, value, rest}` or
  `{:error, reason}`. The decoder accepts only the profile: major types
  2/3/4/5, floats, and the two boolean simple values — and rejects
  non-shortest heads and unsorted map keys (a canonical decoder validates,
  it never repairs).
  """
  @spec decode(binary()) :: {:ok, t(), binary()} | {:error, term()}
  def decode(<<0xF5, rest::binary>>), do: {:ok, {:bool, true}, rest}
  def decode(<<0xF4, rest::binary>>), do: {:ok, {:bool, false}, rest}

  def decode(<<0xF9, b16::16, rest::binary>>) do
    if (b16 >>> 10 &&& 0x1F) == 0x1F do
      {:error, :non_finite_float}
    else
      {:ok, {:float, f16_to_f64(b16)}, rest}
    end
  end

  def decode(<<0xFA, bits::32, _rest::binary>>) when (bits >>> 23 &&& 0xFF) == 0xFF,
    do: {:error, :non_finite_float}

  def decode(<<0xFA, bits::32, rest::binary>>) do
    <<g::float-32>> = <<bits::32>>
    # canonical: an f32 that fits f16 exactly should have been f16
    case f16_bits(g) do
      {:ok, _} -> {:error, {:non_shortest_float, bits}}
      :error -> {:ok, {:float, g}, rest}
    end
  end

  def decode(<<0xFB, bits::64, _rest::binary>>) when (bits >>> 52 &&& 0x7FF) == 0x7FF,
    do: {:error, :non_finite_float}

  def decode(<<0xFB, bits::64, rest::binary>>) do
    <<g::float-64>> = <<bits::64>>

    case f32_bits(g) do
      {:ok, _} -> {:error, {:non_shortest_float, bits}}
      :error -> {:ok, {:float, g}, rest}
    end
  end

  def decode(<<b, _::binary>> = bin) when (b >>> 5) in [2, 3, 4, 5] do
    major = b >>> 5

    with {:ok, n, rest} <- decode_head(bin) do
      case major do
        2 -> take_bytes(n, rest, :bstr)
        3 -> take_bytes(n, rest, :tstr)
        4 -> decode_items(n, rest, [])
        5 -> decode_pairs(n, rest, [])
      end
    end
  end

  def decode(<<b, _::binary>>), do: {:error, {:unsupported_initial_byte, b}}
  def decode(<<>>), do: {:error, :truncated}

  @doc "Decode exactly one item; error if trailing bytes remain."
  @spec decode_exact(binary()) :: {:ok, t()} | {:error, term()}
  def decode_exact(bin) do
    case decode(bin) do
      {:ok, v, <<>>} -> {:ok, v}
      {:ok, _, rest} -> {:error, {:trailing_bytes, byte_size(rest)}}
      {:error, e} -> {:error, e}
    end
  end

  defp decode_head(<<b, rest::binary>>) do
    case b &&& 0x1F do
      n when n < 24 ->
        {:ok, n, rest}

      24 ->
        case rest do
          <<n, r::binary>> when n >= 24 -> {:ok, n, r}
          <<_, _::binary>> -> {:error, :non_shortest_head}
          _ -> {:error, :truncated}
        end

      25 ->
        case rest do
          <<n::16, r::binary>> when n >= 0x100 -> {:ok, n, r}
          <<_::16, _::binary>> -> {:error, :non_shortest_head}
          _ -> {:error, :truncated}
        end

      26 ->
        case rest do
          <<n::32, r::binary>> when n >= 0x10000 -> {:ok, n, r}
          <<_::32, _::binary>> -> {:error, :non_shortest_head}
          _ -> {:error, :truncated}
        end

      27 ->
        case rest do
          <<n::64, r::binary>> when n >= 0x100000000 -> {:ok, n, r}
          <<_::64, _::binary>> -> {:error, :non_shortest_head}
          _ -> {:error, :truncated}
        end

      _ ->
        {:error, :indefinite_length}
    end
  end

  defp take_bytes(n, bin, tag) do
    case bin do
      <<b::binary-size(^n), rest::binary>> ->
        if tag == :tstr and not String.valid?(b) do
          {:error, :invalid_utf8}
        else
          {:ok, {tag, b}, rest}
        end

      _ ->
        {:error, :truncated}
    end
  end

  defp decode_items(0, rest, acc), do: {:ok, {:arr, Enum.reverse(acc)}, rest}

  defp decode_items(n, bin, acc) do
    with {:ok, v, rest} <- decode(bin), do: decode_items(n - 1, rest, [v | acc])
  end

  defp decode_pairs(0, rest, acc), do: check_key_order(Enum.reverse(acc), rest)

  defp decode_pairs(n, bin, acc) do
    with {:ok, k, r1} <- decode(bin),
         {:ok, v, r2} <- decode(r1) do
      decode_pairs(n - 1, r2, [{k, v} | acc])
    end
  end

  defp check_key_order(pairs, rest) do
    encoded_keys = Enum.map(pairs, fn {k, _} -> encode(k) end)

    if encoded_keys == Enum.sort(encoded_keys) and
         length(Enum.uniq(encoded_keys)) == length(encoded_keys) do
      {:ok, {:map, pairs}, rest}
    else
      {:error, :map_keys_not_canonical}
    end
  end

  defp f16_to_f64(bits) do
    <<s::1, e::5, m::10>> = <<bits::16>>

    value =
      cond do
        e == 0 and m == 0 -> 0.0
        e == 0 -> m * :math.pow(2, -24)
        true -> (1 + m / 1024) * :math.pow(2, e - 15)
      end

    if s == 1, do: -value, else: value
  end
end
