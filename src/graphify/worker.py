import json
import sys
from pathlib import Path

from graphify.serve import _GraphContextCache, _query_graph_text


contexts = _GraphContextCache(8)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        graph_path = str((Path(request["repositoryPath"]) / "graphify-out" / "graph.json").resolve())
        graph, _ = contexts.load(graph_path)
        result = _query_graph_text(
            graph,
            request["query"],
            mode="bfs",
            depth=3,
            token_budget=2000,
            graph_path="graphify-out/graph.json",
        )
        response = {"id": request["id"], "result": result}
    except Exception:
        response = {"id": request.get("id") if isinstance(request, dict) else None, "error": "query failed"}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
