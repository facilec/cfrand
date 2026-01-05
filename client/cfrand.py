#!/usr/bin/env python3
"""Single-fetch cfrand RNG that XORs the server hash with local entropy.

Usage:
  import client.cfrand as cfrand

  cfrand.random()
  cfrand.randint(1, 100)
  cfrand.randrange(10, 100, 5)
  cfrand.choice(["a", "b", "c"])
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterable, Optional
from urllib.request import Request, urlopen

def load_dotenv():
  candidates = [
    Path(__file__).resolve().parent / ".env",
    Path(__file__).resolve().parent.parent / ".env",
  ]
  env_path = next((path for path in candidates if path.exists()), None)
  if env_path is None:
    return
  for line in env_path.read_text().splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
      continue
    if "=" not in stripped:
      continue
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key or key in os.environ:
      continue
    os.environ[key] = value.strip()


load_dotenv()


class CFRand:
  def __init__(self, url: Optional[str] = None, timeout: int = 10):
    self._url = url or os.environ.get("CFRAND_URL")
    if not self._url:
      raise RuntimeError("CFRAND_URL is not set; add it to .env")
    self._timeout = timeout
    self._server_bytes = b""
    self._fetch_seed()

  def random(self) -> float:
    value = self._randbits(53)
    return value / (1 << 53)

  def randrange(self, start, stop=None, step=1):
    if stop is None:
      stop = start
      start = 0
    if step == 0:
      raise ValueError("step must not be zero")
    rng = range(start, stop, step)
    count = len(rng)
    if count <= 0:
      raise ValueError("empty range for randrange()")
    index = self._randbelow(count)
    return rng[index]

  def randint(self, a, b):
    return self.randrange(a, b + 1)

  def choice(self, seq: Iterable):
    seq_list = list(seq)
    if not seq_list:
      raise IndexError("Cannot choose from an empty sequence")
    index = self._randbelow(len(seq_list))
    return seq_list[index]

  def shuffle(self, x: list) -> None:
    if len(x) < 2:
      return
    for i in range(len(x) - 1, 0, -1):
      j = self._randbelow(i + 1)
      x[i], x[j] = x[j], x[i]

  def uniform(self, a, b) -> float:
    return a + (b - a) * self.random()

  def _randbelow(self, upper: int) -> int:
    if upper <= 0:
      raise ValueError("upper must be positive")
    bit_size = upper.bit_length()
    while True:
      candidate = self._randbits(bit_size)
      if candidate < upper:
        return candidate

  def _randbits(self, k: int) -> int:
    byte_len = (k + 7) // 8
    data = self._random_bytes(byte_len)
    value = int.from_bytes(data, "big")
    excess = byte_len * 8 - k
    if excess:
      value >>= excess
    return value

  def _random_bytes(self, length: int) -> bytes:
    if length <= 0:
      return b""
    output = bytearray()
    while len(output) < length:
      output.extend(self._xor_block())
    return bytes(output[:length])

  def _xor_block(self) -> bytes:
    entropy = os.urandom(64)
    return bytes(a ^ b for a, b in zip(entropy, self._server_bytes))

  def _fetch_seed(self) -> None:
    req = Request(self._url, headers={"User-Agent": "cfrand-client"})
    with urlopen(req, timeout=self._timeout) as resp:
      if resp.status != 200:
        raise RuntimeError(f"Worker responded with status {resp.status}")
      body = resp.read().decode()
    payload = json.loads(body)
    hex_digest = payload.get("hash_sha3_512")
    if not hex_digest:
      raise RuntimeError("Worker response missing hash_sha3_512")
    try:
      server_bytes = bytes.fromhex(hex_digest)
    except ValueError as exc:
      raise RuntimeError("Worker hash is not valid hex") from exc
    if len(server_bytes) != 64:
      raise RuntimeError("Worker hash is not 512 bits")
    self._server_bytes = server_bytes


_default_rng = CFRand()


def random() -> float:
  return _default_rng.random()


def randrange(start, stop=None, step=1):
  return _default_rng.randrange(start, stop, step)


def randint(a, b):
  return _default_rng.randint(a, b)


def choice(seq: Iterable):
  return _default_rng.choice(seq)


def shuffle(x: list) -> None:
  _default_rng.shuffle(x)


def uniform(a, b) -> float:
  return _default_rng.uniform(a, b)
