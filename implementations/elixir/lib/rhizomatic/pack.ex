defmodule Rhizomatic.Pack do
  @moduledoc """
  The L0 pack (SPEC-8): a physical container for a delta set, one canonical
  CBOR item in the Rhizomatic profile. Determinism is total: same delta set
  ⇒ same pack bytes ⇒ same packId.

  Layout (SPEC-8 §3, plus the `"i"` id field the §4 rehydration contract
  presupposes — see FINDINGS.md F2–F4):

      Pack = { "version": 1, "strings": [tstr...],
               "envelopes": [Record...], "members": [MemberRecord...],
               "loose": [Record...] }

      Record       = { "a": authorIdx, "i": idIdx, "t": timestamp,
                       "p": [Ptr...], "s"?: sigIdx }
      MemberRecord = { "m": envelopeIdx, "i": idIdx, "p": [Ptr...],
                       "a"?: authorIdx, "dt"?: number, "s"?: sigIdx }
      Ptr          = { "r": roleIdx,
                       "e"|"d"|"s": idx | "n": number | "b": bool
                                  | ("m": mimeIdx, "y": bstr),
                       "c"?: ctxIdx }

  All indices are positions in the sorted-unique `strings` table, encoded in
  the profile's float form. Unpacking rehydrates every record and MUST
  verify its content address against the stored id (fsck for free).
  """

  alias Rhizomatic.{Cbor, Delta, Hash}

  @txn_member "rhizomatic.txn.member"

  @typedoc "A delta as packed/unpacked: validated claims plus optional hex sig."
  @type delta :: %{claims: Delta.claims(), sig: String.t() | nil}

  # ------------------------------------------------------------------- pack

  @spec pack([delta()]) :: %{bytes: binary(), pack_id: String.t()}
  def pack(deltas) do
    entries =
      deltas
      |> Enum.map(fn d ->
        %{claims: d.claims, sig: Map.get(d, :sig), id: Delta.id_hex(d.claims)}
      end)
      |> Enum.uniq_by(& &1.id)

    envelopes = entries |> Enum.filter(&manifest?/1) |> Enum.sort_by(& &1.id)
    envelope_ids = MapSet.new(envelopes, & &1.id)

    # member id -> lexicographically-first claiming manifest (by manifest id)
    claimed =
      envelopes
      |> Enum.flat_map(fn m -> Enum.map(member_ids(m), &{&1, m.id}) end)
      |> Enum.reduce(%{}, fn {member_id, manifest_id}, acc ->
        Map.update(acc, member_id, manifest_id, &min(&1, manifest_id))
      end)

    members =
      entries
      |> Enum.filter(fn e -> Map.has_key?(claimed, e.id) and e.id not in envelope_ids end)
      |> Enum.sort_by(& &1.id)

    loose =
      entries
      |> Enum.filter(fn e -> not Map.has_key?(claimed, e.id) and e.id not in envelope_ids end)
      |> Enum.sort_by(& &1.id)

    strings = string_table(entries)
    idx = strings |> Enum.with_index() |> Map.new()
    envelope_index = envelopes |> Enum.map(& &1.id) |> Enum.with_index() |> Map.new()
    envelope_by_id = Map.new(envelopes, &{&1.id, &1})

    pack_ast =
      {:map,
       [
         {{:tstr, "version"}, {:float, 1.0}},
         {{:tstr, "strings"}, {:arr, Enum.map(strings, &{:tstr, &1})}},
         {{:tstr, "envelopes"}, {:arr, Enum.map(envelopes, &record_ast(&1, idx))}},
         {{:tstr, "members"},
          {:arr,
           Enum.map(members, fn e ->
             manifest = envelope_by_id[claimed[e.id]]
             member_ast(e, manifest, envelope_index[manifest.id], idx)
           end)}},
         {{:tstr, "loose"}, {:arr, Enum.map(loose, &record_ast(&1, idx))}}
       ]}

    bytes = Cbor.encode(pack_ast)
    %{bytes: bytes, pack_id: Hash.id_hex(bytes)}
  end

  defp manifest?(%{claims: %{pointers: pointers}}) do
    Enum.any?(pointers, fn
      %{role: @txn_member, target: {:delta, _, _}} -> true
      _ -> false
    end)
  end

  defp member_ids(%{claims: %{pointers: pointers}}) do
    for %{role: @txn_member, target: {:delta, hex, _}} <- pointers, do: hex
  end

  # every string in the set interns: delta ids, sig hexes, authors, roles,
  # contexts, entity ids, delta-ref hexes, string primitives, mimes —
  # sorted unique, bytewise
  defp string_table(entries) do
    entries
    |> Enum.flat_map(fn e ->
      [e.id, e.claims.author] ++
        if(e.sig, do: [e.sig], else: []) ++
        Enum.flat_map(e.claims.pointers, fn %{role: role, target: t} ->
          [role | target_strings(t)]
        end)
    end)
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp target_strings({:string, s}), do: [s]
  defp target_strings({:number, _}), do: []
  defp target_strings({:boolean, _}), do: []
  defp target_strings({:entity, id, ctx}), do: [id | if(ctx, do: [ctx], else: [])]
  defp target_strings({:delta, hex, ctx}), do: [hex | if(ctx, do: [ctx], else: [])]
  defp target_strings({:bytes, mime, _}), do: [mime]

  # hydrated Record for envelopes and loose deltas
  defp record_ast(e, idx) do
    {:map,
     [
       {{:tstr, "a"}, fidx(idx, e.claims.author)},
       {{:tstr, "i"}, fidx(idx, e.id)},
       {{:tstr, "t"}, {:float, e.claims.timestamp}},
       {{:tstr, "p"}, {:arr, Enum.map(e.claims.pointers, &ptr_ast(&1, idx))}}
     ] ++ sig_pair(e, idx)}
  end

  # dehydrated MemberRecord relative to its claiming manifest
  defp member_ast(e, manifest, envelope_idx, idx) do
    dt = e.claims.timestamp - manifest.claims.timestamp

    {:map,
     [
       {{:tstr, "m"}, {:float, envelope_idx * 1.0}},
       {{:tstr, "i"}, fidx(idx, e.id)},
       {{:tstr, "p"}, {:arr, Enum.map(e.claims.pointers, &ptr_ast(&1, idx))}}
     ] ++
       if(e.claims.author == manifest.claims.author,
         do: [],
         else: [{{:tstr, "a"}, fidx(idx, e.claims.author)}]
       ) ++
       if(dt == 0.0, do: [], else: [{{:tstr, "dt"}, {:float, dt}}]) ++
       sig_pair(e, idx)}
  end

  defp sig_pair(%{sig: nil}, _idx), do: []
  defp sig_pair(%{sig: sig}, idx), do: [{{:tstr, "s"}, fidx(idx, sig)}]

  defp ptr_ast(%{role: role, target: target}, idx) do
    {:map, [{{:tstr, "r"}, fidx(idx, role)} | target_ptr_pairs(target, idx)]}
  end

  defp target_ptr_pairs({:string, s}, idx), do: [{{:tstr, "s"}, fidx(idx, s)}]
  defp target_ptr_pairs({:number, f}, _idx), do: [{{:tstr, "n"}, {:float, f}}]
  defp target_ptr_pairs({:boolean, b}, _idx), do: [{{:tstr, "b"}, {:bool, b}}]

  defp target_ptr_pairs({:entity, id, ctx}, idx),
    do: [{{:tstr, "e"}, fidx(idx, id)} | ctx_pair(ctx, idx)]

  defp target_ptr_pairs({:delta, hex, ctx}, idx),
    do: [{{:tstr, "d"}, fidx(idx, hex)} | ctx_pair(ctx, idx)]

  defp target_ptr_pairs({:bytes, mime, payload}, idx),
    do: [{{:tstr, "m"}, fidx(idx, mime)}, {{:tstr, "y"}, {:bstr, payload}}]

  defp ctx_pair(nil, _idx), do: []
  defp ctx_pair(ctx, idx), do: [{{:tstr, "c"}, fidx(idx, ctx)}]

  defp fidx(idx, s), do: {:float, Map.fetch!(idx, s) * 1.0}

  # ----------------------------------------------------------------- unpack

  @doc """
  Decode pack bytes back into the delta set. Every record is rehydrated
  through the standard delta-construction path and its content address MUST
  equal the stored id — a record that does not rehydrate fails the unpack.
  """
  @spec unpack(binary()) :: {:ok, [delta()]} | {:error, term()}
  def unpack(bytes) do
    with {:ok, {:map, pairs}} <- Cbor.decode_exact(bytes),
         {:ok, m} <- pack_fields(pairs),
         {:ok, strings} <- unpack_strings(m["strings"]),
         {:ok, envelopes} <- unpack_records(m["envelopes"], strings),
         {:ok, loose} <- unpack_records(m["loose"], strings),
         {:ok, members} <- unpack_members(m["members"], strings, envelopes) do
      all = envelopes ++ members ++ loose

      Enum.reduce_while(all, {:ok, []}, fn {delta, stored_id}, {:ok, acc} ->
        with {:ok, claims} <- Delta.validate(delta.claims),
             true <- Delta.id_hex(claims) == stored_id || {:error, {:id_mismatch, stored_id}} do
          {:cont, {:ok, [%{claims: claims, sig: delta.sig} | acc]}}
        else
          {:error, e} -> {:halt, {:error, e}}
        end
      end)
      |> case do
        {:ok, acc} -> {:ok, Enum.reverse(acc)}
        err -> err
      end
    else
      {:error, e} -> {:error, e}
      _ -> {:error, :malformed_pack}
    end
  end

  defp pack_fields(pairs) do
    m =
      Map.new(pairs, fn
        {{:tstr, k}, v} -> {k, v}
        {_, v} -> {:bad_key, v}
      end)

    with {:float, 1.0} <- Map.get(m, "version", :missing) do
      if Enum.sort(Map.keys(m)) == ["envelopes", "loose", "members", "strings", "version"] do
        {:ok, m}
      else
        {:error, :malformed_pack}
      end
    else
      _ -> {:error, :unsupported_pack_version}
    end
  end

  defp unpack_strings({:arr, items}) do
    Enum.reduce_while(items, {:ok, []}, fn
      {:tstr, s}, {:ok, acc} -> {:cont, {:ok, [s | acc]}}
      _, _ -> {:halt, {:error, :malformed_strings}}
    end)
    |> case do
      {:ok, acc} -> {:ok, acc |> Enum.reverse() |> List.to_tuple()}
      err -> err
    end
  end

  defp unpack_strings(_), do: {:error, :malformed_strings}

  defp unpack_records({:arr, records}, strings) do
    map_ok(records, fn {:map, pairs} ->
      m = field_map(pairs)

      with {:ok, author} <- table(strings, m["a"]),
           {:ok, id} <- table(strings, m["i"]),
           {:float, ts} <- Map.get(m, "t", :missing),
           {:ok, pointers} <- unpack_ptrs(m["p"], strings),
           {:ok, sig} <- opt_table(strings, m["s"]) do
        {:ok, {%{claims: %{timestamp: ts, author: author, pointers: pointers}, sig: sig}, id}}
      else
        _ -> {:error, :malformed_record}
      end
    end)
  end

  defp unpack_records(_, _), do: {:error, :malformed_pack}

  defp unpack_members({:arr, records}, strings, envelopes) do
    env = List.to_tuple(envelopes)

    map_ok(records, fn {:map, pairs} ->
      m = field_map(pairs)

      with {:ok, env_idx} <- as_index(m["m"]),
           true <- env_idx < tuple_size(env) || {:error, :envelope_index_out_of_range},
           {manifest, _} <- elem(env, env_idx),
           {:ok, id} <- table(strings, m["i"]),
           {:ok, pointers} <- unpack_ptrs(m["p"], strings),
           {:ok, author} <-
             (case m["a"] do
                nil -> {:ok, manifest.claims.author}
                v -> table(strings, v)
              end),
           {:ok, ts} <-
             (case m["dt"] do
                nil -> {:ok, manifest.claims.timestamp}
                {:float, dt} -> {:ok, manifest.claims.timestamp + dt}
                _ -> {:error, :malformed_record}
              end),
           {:ok, sig} <- opt_table(strings, m["s"]) do
        {:ok, {%{claims: %{timestamp: ts, author: author, pointers: pointers}, sig: sig}, id}}
      else
        _ -> {:error, :malformed_record}
      end
    end)
  end

  defp unpack_members(_, _, _), do: {:error, :malformed_pack}

  defp unpack_ptrs({:arr, ptrs}, strings) do
    map_ok(ptrs, fn {:map, pairs} ->
      m = field_map(pairs)

      with {:ok, role} <- table(strings, m["r"]),
           {:ok, target} <- unpack_target(m, strings) do
        {:ok, %{role: role, target: target}}
      else
        _ -> {:error, :malformed_ptr}
      end
    end)
  end

  defp unpack_ptrs(_, _), do: {:error, :malformed_pack}

  defp unpack_target(m, strings) do
    ctx =
      case m["c"] do
        nil -> {:ok, nil}
        v -> table(strings, v)
      end

    with {:ok, context} <- ctx do
      cond do
        Map.has_key?(m, "e") ->
          with {:ok, id} <- table(strings, m["e"]), do: {:ok, {:entity, id, context}}

        Map.has_key?(m, "d") ->
          with {:ok, hex} <- table(strings, m["d"]), do: {:ok, {:delta, hex, context}}

        Map.has_key?(m, "s") ->
          with {:ok, s} <- table(strings, m["s"]), do: {:ok, {:string, s}}

        Map.has_key?(m, "n") ->
          case m["n"] do
            {:float, f} -> {:ok, {:number, f}}
            _ -> {:error, :malformed_ptr}
          end

        Map.has_key?(m, "b") ->
          case m["b"] do
            {:bool, b} -> {:ok, {:boolean, b}}
            _ -> {:error, :malformed_ptr}
          end

        Map.has_key?(m, "y") ->
          with {:ok, mime} <- table(strings, m["m"]),
               {:bstr, payload} <- m["y"] do
            {:ok, {:bytes, mime, payload}}
          else
            _ -> {:error, :malformed_ptr}
          end

        true ->
          {:error, :malformed_ptr}
      end
    end
  end

  defp field_map(pairs) do
    Map.new(pairs, fn
      {{:tstr, k}, v} -> {k, v}
      {k, v} -> {k, v}
    end)
  end

  defp table(strings, v) do
    with {:ok, i} <- as_index(v),
         true <- i < tuple_size(strings) || :error do
      {:ok, elem(strings, i)}
    else
      _ -> {:error, :string_index_out_of_range}
    end
  end

  defp opt_table(_strings, nil), do: {:ok, nil}
  defp opt_table(strings, v), do: table(strings, v)

  defp as_index({:float, f}) when f >= 0 do
    i = trunc(f)
    if i * 1.0 == f, do: {:ok, i}, else: {:error, :non_integer_index}
  end

  defp as_index(_), do: {:error, :malformed_index}

  defp map_ok(items, fun) do
    Enum.reduce_while(items, {:ok, []}, fn item, {:ok, acc} ->
      case fun.(item) do
        {:ok, v} -> {:cont, {:ok, [v | acc]}}
        {:error, e} -> {:halt, {:error, e}}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      err -> err
    end
  end
end
