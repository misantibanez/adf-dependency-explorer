"""HTML portal for published ADF snapshots; Azure extraction is notebook-only."""

import logging
import os
from pathlib import Path
from uuid import UUID

from flask import Flask, jsonify, send_from_directory

from repository import from_environment

ASSETS = {"portal.js", "portal.css", "graph.js", "history.js"}


def create_app(repository=None):
    repository = repository if repository is not None else from_environment()
    static = Path(__file__).resolve().parent / "static"
    missing = [name for name in ASSETS if not (static / name).is_file()]
    if missing:
        raise RuntimeError("Ejecutar databricks/prepare_app.py antes de desplegar; faltan: " + ", ".join(sorted(missing)))
    app = Flask(__name__, static_folder=None)

    @app.after_request
    def secure(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        )
        return response

    @app.get("/")
    def index():
        return send_from_directory(static, "index.html")

    @app.get("/assets/<name>")
    def asset(name):
        if name not in ASSETS:
            return jsonify(error="Recurso no disponible."), 404
        return send_from_directory(static, name)

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.get("/api/snapshots")
    def snapshots():
        return jsonify(snapshots=repository.list_snapshots())

    @app.get("/api/snapshots/<snapshot_id>")
    def snapshot(snapshot_id):
        try:
            UUID(snapshot_id)
        except ValueError:
            return jsonify(error="Snapshot invalido."), 400
        result = repository.get_snapshot(snapshot_id)
        if result is None:
            return jsonify(error="Snapshot no encontrado."), 404
        return jsonify(result)

    @app.errorhandler(Exception)
    def failure(error):
        from werkzeug.exceptions import HTTPException

        if isinstance(error, HTTPException):
            return jsonify(error="Ruta o metodo no disponible."), error.code
        # Do not log SQL response bodies, credentials or snapshot definitions.
        app.logger.error("Fallo al leer el snapshot (%s).", type(error).__name__)
        return jsonify(error="No se pudieron leer las tablas. Revisar warehouse, permisos y logs de la App."), 503

    return app


if __name__ == "__main__":
    from waitress import serve

    logging.basicConfig(level=logging.INFO)
    serve(create_app(), host="0.0.0.0", port=int(os.environ.get("DATABRICKS_APP_PORT", "8000")))
