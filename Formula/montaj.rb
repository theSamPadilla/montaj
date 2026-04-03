class Montaj < Formula
  desc "Video editing toolkit — local-first, CLI-driven, agent-friendly"
  homepage "https://github.com/ByCrux/montaj"
  url "https://github.com/ByCrux/montaj/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/ByCrux/montaj.git", branch: "main"

  depends_on "python@3.12"
  depends_on "ffmpeg"
  depends_on "whisper-cpp"

  def install
    venv = virtualenv_create(libexec, "python3.12")
    venv.pip_install_and_link "#{buildpath}[serve]"
  end

  def caveats
    <<~EOS
      API keys for adaptors (optional) are stored in:
        ~/.montaj/credentials.json
    EOS
  end

  test do
    system bin/"montaj", "--help"
    system bin/"mtj", "--help"
  end
end
