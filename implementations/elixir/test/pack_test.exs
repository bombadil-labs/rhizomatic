defmodule PackTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, Pack, Vectors}

  # l0-pack/*.json — the SPEC-8 round-trip: byte-exact pack bytes and
  # packId, then unpack -> identical delta set. pack-bytes.json pins the
  # bytes-target m/y records (D12; generated for #19, closing FINDINGS F1).
  for file <- ["l0-pack/pack.json", "l0-pack/pack-bytes.json"] do
    test "#{file}: pack bytes and packId are byte-exact" do
      vector = Vectors.load!(unquote(file))
      deltas = parse_deltas(vector["deltas"])

      %{bytes: bytes, pack_id: pack_id} = Pack.pack(deltas)
      assert Vectors.hex(bytes) == vector["packHex"]
      assert pack_id == vector["packId"]
    end
  end

  test "pack.json: unpack rehydrates the identical delta set (fsck passes)" do
    vector = Vectors.load!("l0-pack/pack.json")
    deltas = parse_deltas(vector["deltas"])

    assert {:ok, unpacked} = Pack.unpack(Vectors.unhex(vector["packHex"]))

    expected = Enum.map(deltas, &{Delta.id_hex(&1.claims), &1.sig}) |> Enum.sort()
    actual = Enum.map(unpacked, &{Delta.id_hex(&1.claims), &1.sig}) |> Enum.sort()
    assert actual == expected

    # and repacking the unpacked set reproduces the same physical bytes
    assert Vectors.hex(Pack.pack(unpacked).bytes) == vector["packHex"]
  end

  test "a corrupted record fails the content-address check on unpack" do
    vector = Vectors.load!("l0-pack/pack.json")
    deltas = parse_deltas(vector["deltas"])
    %{bytes: bytes} = Pack.pack(deltas)

    # flip a byte inside a string-table entry ("The Matrix" -> "Thf Matrix"):
    # the record still parses but no longer rehydrates to its stored id
    corrupted = :binary.replace(bytes, "The Matrix", "Thf Matrix")
    assert corrupted != bytes
    assert {:error, _} = Pack.unpack(corrupted)
  end

  defp parse_deltas(deltas_json) do
    Enum.map(deltas_json, fn d ->
      %{claims: Vectors.parse_claims!(d["claims"]), sig: Map.get(d, "sig")}
    end)
  end
end
