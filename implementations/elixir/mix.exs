defmodule Rhizomatic.MixProject do
  use Mix.Project

  def project do
    [
      app: :rhizomatic,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:crypto]]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # No runtime deps, on purpose: canonical CBOR, the f16/f32 float ladder,
  # BLAKE3, base64url validation, and strict Ed25519 verification are all
  # hand-rolled from their specs; Ed25519 *signing* and SHA-512 come from
  # OTP's :crypto, NFC from OTP's :unicode, JSON from Elixir's built-in JSON.
  defp deps do
    []
  end
end
