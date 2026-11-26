"""PostgreSQL connection for the hosted app."""
from psycopg import connect, sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row


class Postgres:
    def __init__(self, dsn):
        settings = conninfo_to_dict(dsn)
        settings.setdefault("sslmode", "require")
        settings.setdefault("connect_timeout", 5)
        self.connection = connect(**settings, autocommit=True, row_factory=dict_row,
                                  prepare_threshold=None)

    def execute(self, statement, params=()):
        return self.connection.execute(statement.replace("?", "%s"), params)

    def __enter__(self):
        self.transaction = self.connection.transaction()
        self.transaction.__enter__()
        return self

    def __exit__(self, *error):
        return self.transaction.__exit__(*error)

    def lock(self, *tables):
        query = sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(
            sql.SQL(", ").join(map(sql.Identifier, tables))
        )
        self.connection.execute(query)

    def close(self):
        self.connection.close()
