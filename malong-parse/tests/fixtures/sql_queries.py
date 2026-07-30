import os
import sqlite3


def query_users(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.execute("SELECT * FROM users WHERE active = 1")
    rows = cursor.fetchall()
    conn.execute("INSERT INTO audit_log (action) VALUES ('query')")
    conn.execute("DELETE FROM sessions WHERE expired = 1")
    conn.execute("UPDATE users SET last_seen = datetime('now')")
    return rows


DB_HOST = os.environ["DB_HOST"]
API_KEY = os.getenv("API_KEY")
