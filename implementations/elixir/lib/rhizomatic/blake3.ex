defmodule Rhizomatic.Blake3 do
  @moduledoc """
  Pure-Elixir BLAKE3-256 (the default 32-byte hash mode only).

  BLAKE3 is an external standard with its own published test vectors; this is
  a boring, direct transcription of the reference algorithm — chunk chaining
  values, the 7-round compression function, and the binary tree over chunk
  CVs — with no keyed/derive-key modes and no extended output. Performance is
  a non-goal: this runs in the conformance tests.
  """

  import Bitwise

  @iv {0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB,
       0x5BE0CD19}

  @msg_permutation [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8]

  @chunk_start 1
  @chunk_end 2
  @parent 4
  @root 8

  @mask32 0xFFFFFFFF

  @spec hash(binary()) :: binary()
  def hash(input) do
    case chunk_list(input) do
      [{0, only}] ->
        # single chunk: the chunk's last block is the root compression
        {cv, last_block, last_len, last_flags} = chunk_blocks_fold(only, 0)
        out = compress(cv, last_block, 0, last_len, last_flags ||| @root)
        first_8_words_bytes(out)

      chunks ->
        chunks
        |> Enum.map(fn {i, chunk} ->
          {cv, last_block, last_len, last_flags} = chunk_blocks_fold(chunk, i)
          first_8_words(compress(cv, last_block, i, last_len, last_flags))
        end)
        |> tree_root()
    end
  end

  # -------------------------------------------------------------- chunking

  # 1024-byte chunks; empty input is one empty chunk
  defp chunk_list(<<>>), do: [{0, <<>>}]

  defp chunk_list(input) do
    input |> split_every(1024) |> Enum.with_index() |> Enum.map(fn {c, i} -> {i, c} end)
  end

  defp split_every(bin, n) when byte_size(bin) <= n, do: [bin]

  defp split_every(bin, n) do
    <<h::binary-size(^n), t::binary>> = bin
    [h | split_every(t, n)]
  end

  # Fold all blocks of a chunk except the last through the compression,
  # returning {cv_before_last_block, last_block, last_block_len, last_flags}.
  # The caller decides whether the last block also carries ROOT.
  defp chunk_blocks_fold(chunk, counter) do
    blocks = if chunk == <<>>, do: [<<>>], else: split_every(chunk, 64)
    n = length(blocks)

    {cv, _} =
      blocks
      |> Enum.take(n - 1)
      |> Enum.with_index()
      |> Enum.reduce({@iv, nil}, fn {block, i}, {cv, _} ->
        flags = if i == 0, do: @chunk_start, else: 0
        {first_8_words(compress(cv, block, counter, byte_size(block), flags)), nil}
      end)

    last = List.last(blocks)
    last_flags = if(n == 1, do: @chunk_start, else: 0) ||| @chunk_end
    {cv, last, byte_size(last), last_flags}
  end

  # ------------------------------------------------------------------ tree

  defp tree_root([_, _ | _] = cvs) do
    {left, right} = split_tree(cvs)
    block = cv_bytes(tree_cv(left)) <> cv_bytes(tree_cv(right))
    first_8_words_bytes(compress(@iv, block, 0, 64, @parent ||| @root))
  end

  defp tree_cv([cv]), do: cv

  defp tree_cv(cvs) do
    {left, right} = split_tree(cvs)
    block = cv_bytes(tree_cv(left)) <> cv_bytes(tree_cv(right))
    first_8_words(compress(@iv, block, 0, 64, @parent))
  end

  # left subtree gets the largest power of two strictly less than n leaves
  defp split_tree(cvs) do
    n = length(cvs)
    Enum.split(cvs, largest_pow2_lt(n))
  end

  defp largest_pow2_lt(n) when n >= 2, do: 1 <<< (bit_width(n - 1) - 1)

  defp bit_width(x) when x > 0, do: length(Integer.digits(x, 2))

  # ----------------------------------------------------------- compression

  # full 16-word output state after the xor folding
  defp compress(cv, block, counter, block_len, flags) do
    m = block_words(block)

    state =
      List.to_tuple(
        Tuple.to_list(cv) ++
          [elem(@iv, 0), elem(@iv, 1), elem(@iv, 2), elem(@iv, 3)] ++
          [counter &&& @mask32, counter >>> 32 &&& @mask32, block_len, flags]
      )

    {state, _} =
      Enum.reduce(1..7, {state, m}, fn round, {st, mw} ->
        {do_round(st, mw), if(round == 7, do: mw, else: permute(mw))}
      end)

    Enum.reduce(0..7, state, fn i, st ->
      st
      |> put_elem(i, bxor(elem(st, i), elem(st, i + 8)))
      |> put_elem(i + 8, bxor(elem(st, i + 8), elem(cv, i)))
    end)
  end

  defp first_8_words(state16), do: state16 |> Tuple.to_list() |> Enum.take(8) |> List.to_tuple()

  defp first_8_words_bytes(state16), do: state16 |> first_8_words() |> cv_bytes()

  defp cv_bytes(cv8) do
    cv8 |> Tuple.to_list() |> Enum.map(&<<&1::little-32>>) |> IO.iodata_to_binary()
  end

  # pad the (≤64-byte) block with zeros; 16 little-endian u32 words
  defp block_words(block) do
    padded = block <> :binary.copy(<<0>>, 64 - byte_size(block))
    for(<<w::little-32 <- padded>>, do: w) |> List.to_tuple()
  end

  defp permute(m), do: @msg_permutation |> Enum.map(&elem(m, &1)) |> List.to_tuple()

  defp do_round(st, m) do
    st
    |> g(0, 4, 8, 12, elem(m, 0), elem(m, 1))
    |> g(1, 5, 9, 13, elem(m, 2), elem(m, 3))
    |> g(2, 6, 10, 14, elem(m, 4), elem(m, 5))
    |> g(3, 7, 11, 15, elem(m, 6), elem(m, 7))
    |> g(0, 5, 10, 15, elem(m, 8), elem(m, 9))
    |> g(1, 6, 11, 12, elem(m, 10), elem(m, 11))
    |> g(2, 7, 8, 13, elem(m, 12), elem(m, 13))
    |> g(3, 4, 9, 14, elem(m, 14), elem(m, 15))
  end

  defp g(st, ia, ib, ic, id, mx, my) do
    a = elem(st, ia)
    b = elem(st, ib)
    c = elem(st, ic)
    d = elem(st, id)

    a = a + b + mx &&& @mask32
    d = rotr32(bxor(d, a), 16)
    c = c + d &&& @mask32
    b = rotr32(bxor(b, c), 12)
    a = a + b + my &&& @mask32
    d = rotr32(bxor(d, a), 8)
    c = c + d &&& @mask32
    b = rotr32(bxor(b, c), 7)

    st |> put_elem(ia, a) |> put_elem(ib, b) |> put_elem(ic, c) |> put_elem(id, d)
  end

  defp rotr32(x, n), do: (x >>> n ||| x <<< (32 - n)) &&& @mask32
end
