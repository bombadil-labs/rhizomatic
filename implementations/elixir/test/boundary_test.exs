defmodule BoundaryTest do
  use ExUnit.Case, async: true

  alias Rhizomatic.{Delta, Profile}

  # Per-witness boundary tests for policies a JSON vector file cannot
  # express (vectors/README.md §3).

  describe "host-boundary numeric policy (SPEC-1 §4.1 / ERRATA D14)" do
    test "claim construction rejects a native integer timestamp" do
      assert {:error, {:native_integer, :timestamp}} =
               Delta.validate(%{
                 timestamp: 42,
                 author: "did:key:zA",
                 pointers: [%{role: "x", target: {:string, "y"}}]
               })
    end

    test "claim construction rejects a native integer primitive target" do
      assert {:error, {:native_integer, :target}} =
               Delta.validate(%{
                 timestamp: 0.0,
                 author: "did:key:zA",
                 pointers: [%{role: "answer", target: {:number, 42}}]
               })
    end

    test "the same values as floats are accepted (42 and 42.0 are distinct terms)" do
      assert {:ok, _} =
               Delta.validate(%{
                 timestamp: 42.0,
                 author: "did:key:zA",
                 pointers: [%{role: "answer", target: {:number, 42.0}}]
               })
    end

    test "the JSON profile parser is the one blessed coercion point" do
      {:ok, a} =
        Profile.parse_claims(%{
          "timestamp" => 42,
          "author" => "did:key:zA",
          "pointers" => [%{"role" => "answer", "target" => 42}]
        })

      {:ok, b} =
        Profile.parse_claims(%{
          "timestamp" => 42.0,
          "author" => "did:key:zA",
          "pointers" => [%{"role" => "answer", "target" => 42.0}]
        })

      assert Delta.canonical_bytes(a) == Delta.canonical_bytes(b)
    end

    test "a JSON integer not exactly representable as f64 is rejected, never rounded" do
      # 2^53 + 1
      big = 9_007_199_254_740_993

      assert {:error, {:not_exact_f64, _}} =
               Profile.parse_claims(%{
                 "timestamp" => 0,
                 "author" => "did:key:zA",
                 "pointers" => [%{"role" => "n", "target" => big}]
               })
    end

    test "a JSON integer above 2^53 that IS exactly representable is accepted" do
      # 2^53 + 2
      exact = 9_007_199_254_740_994

      assert {:ok, claims} =
               Profile.parse_claims(%{
                 "timestamp" => 0,
                 "author" => "did:key:zA",
                 "pointers" => [%{"role" => "n", "target" => exact}]
               })

      assert [%{target: {:number, f}}] = claims.pointers
      assert trunc(f) == exact
    end
  end

  describe "byte-honest strings (SPEC-1 §4.1 / ERRATA D16: NFC demoted to authoring hygiene)" do
    # e + U+0301 COMBINING ACUTE ACCENT: valid UTF-8, canonically equivalent
    # to U+00E9, but not NFC. Explicit UTF-8 bytes so no editor or tool can
    # silently normalize a literal.
    @nfd_e <<?e, 0xCC, 0x81>>
    # the precomposed (NFC) form of the same text, U+00E9
    @nfc_e <<0xC3, 0xA9>>

    test "the fixture strings are what they claim to be" do
      assert @nfd_e != @nfc_e
      assert :unicode.characters_to_nfc_binary(@nfd_e) == @nfc_e
    end

    test "both spellings are admitted in every string position" do
      assert {:ok, _} =
               Delta.validate(%{
                 timestamp: 0.0,
                 author: "did:key:zAuthor" <> @nfd_e,
                 pointers: [
                   %{role: @nfd_e, target: {:string, @nfd_e}},
                   %{role: "ctx", target: {:entity, "entity:a", @nfd_e}},
                   %{role: "icon", target: {:bytes, "image/png" <> @nfd_e, <<1>>}}
                 ]
               })
    end

    test "the two spellings are two distinct claims (different bytes, different ids)" do
      mk = fn s ->
        {:ok, claims} =
          Delta.validate(%{
            timestamp: 0.0,
            author: "did:key:zA",
            pointers: [%{role: s, target: {:string, s}}]
          })

        Delta.id_hex(claims)
      end

      # canonical equivalence is a human judgment the substrate declines to make
      # (the same honesty as image/PNG vs image/png, D12)
      assert mk.(@nfd_e) != mk.(@nfc_e)
    end

    test "an invalid UTF-8 binary is still rejected (text must be text)" do
      assert {:error, {:not_a_string, :role}} =
               Delta.validate(%{
                 timestamp: 0.0,
                 author: "did:key:zA",
                 pointers: [%{role: <<0xFF, 0xFE>>, target: {:string, "y"}}]
               })
    end
  end
end
