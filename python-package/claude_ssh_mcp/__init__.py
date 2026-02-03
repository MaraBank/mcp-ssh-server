#!/usr/bin/env python3
"""
claude-ssh-mcp - MCP addon for Claude Desktop providing SSH capabilities.

This package automatically installs Node.js and runs the npm package.
"""

import os
import sys
import subprocess
import shutil
import platform
import urllib.request
import tarfile
import zipfile
import tempfile
from pathlib import Path

__version__ = "1.0.0"

# Node.js version to install if not found
NODE_VERSION = "20.11.0"

def get_node_paths():
    """Get paths where Node.js might be installed."""
    home = Path.home()
    paths = []

    if platform.system() == "Windows":
        paths = [
            home / ".claude-ssh-mcp" / "node",
            Path(os.environ.get("PROGRAMFILES", "C:\\Program Files")) / "nodejs",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "node",
        ]
    else:
        paths = [
            home / ".claude-ssh-mcp" / "node",
            Path("/usr/local/bin"),
            Path("/usr/bin"),
            home / ".local" / "bin",
            home / ".nvm" / "versions" / "node" / f"v{NODE_VERSION}" / "bin",
        ]

    return paths


def find_node():
    """Find Node.js executable."""
    # Check if node is in PATH
    node_cmd = "node.exe" if platform.system() == "Windows" else "node"
    node_path = shutil.which(node_cmd)
    if node_path:
        return node_path

    # Check common installation paths
    for base_path in get_node_paths():
        if platform.system() == "Windows":
            node_exe = base_path / "node.exe"
        else:
            node_exe = base_path / "node"

        if node_exe.exists():
            return str(node_exe)

    return None


def find_npx():
    """Find npx executable."""
    npx_cmd = "npx.cmd" if platform.system() == "Windows" else "npx"
    npx_path = shutil.which(npx_cmd)
    if npx_path:
        return npx_path

    # Check relative to node
    node_path = find_node()
    if node_path:
        node_dir = Path(node_path).parent
        if platform.system() == "Windows":
            npx_exe = node_dir / "npx.cmd"
        else:
            npx_exe = node_dir / "npx"

        if npx_exe.exists():
            return str(npx_exe)

    return None


def get_node_download_url():
    """Get the Node.js download URL for the current platform."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("i386", "i686", "x86"):
        arch = "x86"
    else:
        arch = "x64"  # Default

    if system == "windows":
        return f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-{arch}.zip"
    elif system == "darwin":
        return f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-{arch}.tar.gz"
    else:  # Linux
        return f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-{arch}.tar.xz"


def install_nodejs():
    """Download and install Node.js."""
    install_dir = Path.home() / ".claude-ssh-mcp" / "node"
    install_dir.mkdir(parents=True, exist_ok=True)

    url = get_node_download_url()
    print(f"Downloading Node.js from {url}...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Download
        if url.endswith(".zip"):
            archive_path = tmpdir / "node.zip"
        elif url.endswith(".tar.xz"):
            archive_path = tmpdir / "node.tar.xz"
        else:
            archive_path = tmpdir / "node.tar.gz"

        urllib.request.urlretrieve(url, archive_path)
        print("Extracting...")

        # Extract
        if url.endswith(".zip"):
            with zipfile.ZipFile(archive_path, 'r') as zf:
                zf.extractall(tmpdir)
        elif url.endswith(".tar.xz"):
            import lzma
            with lzma.open(archive_path) as xz:
                with tarfile.open(fileobj=xz) as tar:
                    tar.extractall(tmpdir)
        else:
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(tmpdir)

        # Find extracted directory
        extracted = None
        for item in tmpdir.iterdir():
            if item.is_dir() and item.name.startswith("node-"):
                extracted = item
                break

        if not extracted:
            raise RuntimeError("Failed to find extracted Node.js directory")

        # Move to install location
        if platform.system() == "Windows":
            # On Windows, copy the contents directly
            for item in extracted.iterdir():
                dest = install_dir / item.name
                if dest.exists():
                    if dest.is_dir():
                        shutil.rmtree(dest)
                    else:
                        dest.unlink()
                shutil.move(str(item), str(dest))
        else:
            # On Unix, copy bin, lib, etc.
            for item in extracted.iterdir():
                dest = install_dir / item.name
                if dest.exists():
                    if dest.is_dir():
                        shutil.rmtree(dest)
                    else:
                        dest.unlink()
                shutil.move(str(item), str(dest))

    # Verify installation
    if platform.system() == "Windows":
        node_exe = install_dir / "node.exe"
    else:
        node_exe = install_dir / "bin" / "node"

    if not node_exe.exists():
        raise RuntimeError(f"Node.js installation failed - {node_exe} not found")

    print(f"Node.js installed to {install_dir}")
    return str(node_exe)


def ensure_nodejs():
    """Ensure Node.js is installed, installing it if necessary."""
    node_path = find_node()
    if node_path:
        return node_path

    print("Node.js not found. Installing...")
    return install_nodejs()


def run_npx(*args):
    """Run npx with the given arguments."""
    npx_path = find_npx()

    if not npx_path:
        # Ensure Node.js is installed
        node_path = ensure_nodejs()
        node_dir = Path(node_path).parent

        if platform.system() == "Windows":
            npx_path = str(node_dir / "npx.cmd")
        else:
            npx_path = str(node_dir / "npx")

    # Run npx
    cmd = [npx_path] + list(args)
    return subprocess.call(cmd)


def main():
    """Main entry point."""
    # Ensure Node.js is available
    ensure_nodejs()

    # Run the npm package
    sys.exit(run_npx("-y", "claude-ssh-mcp"))


def install():
    """Install command - adds to Claude Desktop config."""
    ensure_nodejs()
    sys.exit(run_npx("-y", "claude-ssh-mcp"))


if __name__ == "__main__":
    main()
