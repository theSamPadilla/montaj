class Montaj < Formula
  desc "Video editing toolkit — local-first, CLI-driven, agent-friendly"
  homepage "https://github.com/ByCrux/montaj"
  url "https://github.com/ByCrux/montaj/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/ByCrux/montaj.git", branch: "main"

  depends_on "python@3.12"

  def install
    venv = virtualenv_create(libexec, "python3.12")
    venv.pip_install_and_link "#{buildpath}[serve]"
  end

  def caveats
    <<~EOS
      Complete setup by downloading the whisper binary and model weights:
        montaj install

      Optional — background removal support:
        montaj install rvm

      API keys for adaptors are stored in:
        ~/.montaj/credentials.json
    EOS
  end

  test do
    system bin/"montaj", "--help"
    system bin/"mtj", "--help"
  end
end
