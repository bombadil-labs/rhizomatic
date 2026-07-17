defmodule Rhizomatic.Ed25519 do
  @moduledoc """
  Ed25519 for the delta layer (SPEC-1 §5, §5.1).

  * **Signing** delegates to OTP's `:crypto` — RFC 8032 signing is
    deterministic and identical under every acceptance criterion.
  * **Verification** implements SPEC-1 §5.1's five-check STRICT criterion
    explicitly, in pure-Elixir Edwards arithmetic — never a library's default
    verifier, because library notions of "strict" vary:

      1. canonical scalar: `S < L` (little-endian);
      2. canonical encoding of `A` (decompress → recompress reproduces bytes);
      3. canonical encoding of `R` (same check);
      4. no small-order components: `[8]A ≠ 𝒪` and `[8]R ≠ 𝒪`;
      5. cofactorless equation, exactly: `[S]B = R + [k]A`,
         `k = SHA-512(R ‖ A ‖ M) mod L`.

  Correctness over speed: this runs in tests.
  """

  import Bitwise

  @p (1 <<< 255) - 19
  @l (1 <<< 252) + 27_742_317_777_372_353_535_851_937_790_883_648_493
  @d 37_095_705_934_669_439_343_138_083_508_754_565_189_542_113_879_843_219_016_388_785_533_085_940_283_555

  @bx 15_112_221_349_535_400_772_501_151_409_588_531_511_454_012_693_041_857_206_046_113_283_949_847_762_202
  @by 46_316_835_694_926_478_169_428_394_003_475_163_141_307_993_866_256_225_615_783_033_603_165_251_855_960

  # extended coordinates {X, Y, Z, T}; identity is (0 : 1 : 1 : 0)
  @identity {0, 1, 1, 0}

  # ------------------------------------------------------------------ keys

  @doc "Derive the 32-byte public key from a 32-byte seed (RFC 8032)."
  @spec public_key(binary()) :: binary()
  def public_key(<<seed::binary-32>>) do
    {pub, _} = :crypto.generate_key(:eddsa, :ed25519, seed)
    pub
  end

  @doc "Deterministic RFC 8032 signature (64 bytes) over `msg` by `seed`."
  @spec sign(binary(), binary()) :: binary()
  def sign(msg, <<seed::binary-32>>) do
    :crypto.sign(:eddsa, :none, msg, [seed, :ed25519])
  end

  # ---------------------------------------------------- strict verification

  @doc """
  SPEC-1 §5.1 strict verification of a 64-byte signature over `msg` against
  a 32-byte public key. Returns `true` iff all five checks pass.
  """
  @spec verify_strict(binary(), binary(), binary()) :: boolean()
  def verify_strict(<<r_bytes::binary-32, s_bytes::binary-32>>, msg, <<a_bytes::binary-32>>) do
    s = :binary.decode_unsigned(s_bytes, :little)

    with true <- s < @l,
         {:ok, a} <- decompress_canonical(a_bytes),
         {:ok, r} <- decompress_canonical(r_bytes),
         false <- small_order?(a),
         false <- small_order?(r) do
      k =
        :crypto.hash(:sha512, r_bytes <> a_bytes <> msg)
        |> :binary.decode_unsigned(:little)
        |> rem(@l)

      # [S]B = R + [k]A, exactly — no cofactor multiplication on either side
      point_equal(scalar_mult(s, basepoint()), point_add(r, scalar_mult(k, a)))
    else
      _ -> false
    end
  end

  def verify_strict(_, _, _), do: false

  # ----------------------------------------------------------- point codec

  # Canonical decode: the 32 bytes must decompress to a curve point whose
  # re-compression reproduces the identical bytes. Rejects y >= p and a set
  # sign bit when x = 0.
  defp decompress_canonical(<<bytes::binary-32>>) do
    n = :binary.decode_unsigned(bytes, :little)
    sign = n >>> 255 &&& 1
    y = n &&& (1 <<< 255) - 1

    cond do
      y >= @p ->
        :error

      true ->
        case recover_x(y) do
          {:ok, x} ->
            cond do
              x == 0 and sign == 1 -> :error
              (x &&& 1) != sign -> {:ok, to_extended(@p - x, y)}
              true -> {:ok, to_extended(x, y)}
            end

          :error ->
            :error
        end
    end
  end

  # x² = (y² - 1) / (d·y² + 1)  (twisted Edwards, a = -1)
  defp recover_x(y) do
    y2 = mulm(y, y)
    u = subm(y2, 1)
    v = addm(mulm(@d, y2), 1)
    # candidate root: (u/v)^((p+3)/8) = u · v³ · (u · v⁷)^((p-5)/8)
    v3 = mulm(mulm(v, v), v)
    v7 = mulm(mulm(v3, v3), v)
    x = mulm(mulm(u, v3), powm(mulm(u, v7), div(@p - 5, 8)))
    vx2 = mulm(v, mulm(x, x))

    cond do
      vx2 == mod(u) -> {:ok, x}
      vx2 == mod(-u) -> {:ok, mulm(x, powm(2, div(@p - 1, 4)))}
      true -> :error
    end
  end

  defp to_extended(x, y), do: {x, y, 1, mulm(x, y)}

  # ------------------------------------------------------ point arithmetic

  defp basepoint, do: to_extended(@bx, @by)

  # complete addition on twisted Edwards a=-1, extended coordinates
  defp point_add({x1, y1, z1, t1}, {x2, y2, z2, t2}) do
    a = mulm(subm(y1, x1), subm(y2, x2))
    b = mulm(addm(y1, x1), addm(y2, x2))
    c = mulm(mulm(2, @d), mulm(t1, t2))
    dd = mulm(2, mulm(z1, z2))
    e = subm(b, a)
    f = subm(dd, c)
    g = addm(dd, c)
    h = addm(b, a)
    {mulm(e, f), mulm(g, h), mulm(f, g), mulm(e, h)}
  end

  defp scalar_mult(k, point) when k >= 0 do
    do_scalar_mult(k, point, @identity)
  end

  defp do_scalar_mult(0, _p, acc), do: acc

  defp do_scalar_mult(k, p, acc) do
    acc = if (k &&& 1) == 1, do: point_add(acc, p), else: acc
    do_scalar_mult(k >>> 1, point_add(p, p), acc)
  end

  defp point_equal({x1, y1, z1, _}, {x2, y2, z2, _}) do
    mod(x1 * z2 - x2 * z1) == 0 and mod(y1 * z2 - y2 * z1) == 0
  end

  defp small_order?(point) do
    point_equal(scalar_mult(8, point), @identity)
  end

  # ---------------------------------------------------------- field helpers

  defp mod(x), do: Integer.mod(x, @p)
  defp addm(a, b), do: mod(a + b)
  defp subm(a, b), do: mod(a - b)
  defp mulm(a, b), do: mod(a * b)

  defp powm(base, exp) do
    :crypto.mod_pow(base, exp, @p) |> :binary.decode_unsigned()
  end
end
