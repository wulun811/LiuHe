import os.path
import json
import hashlib


def process(data):
    return os.path.join("/tmp", data)


def unused_func():
    return hashlib.md5(b"x").hexdigest()
