# The agents service: the LangGraph Agent Server with our graphs. Based on what `langgraph dockerfile`
# generates, tidied for hadolint, pinned by digest and run as a non-root user.
# Build from this directory: docker build services/agents

FROM langchain/langgraph-api:3.12@sha256:6edd1cd4fab2b3ed9c3725ca6f237d55afdf55747026c3602cebd41d09d3173c

WORKDIR /deps/agents
COPY . .

# Install our package against the server's constraints, make sure that didn't overwrite the server
# itself, then strip the package-install tooling and the Datadog tracer (only used when DD_API_KEY is
# set; gamenight traces through OpenTelemetry) from the final image.
RUN PYTHONDONTWRITEBYTECODE=1 uv pip install --system --no-cache-dir -c /api/constraints.txt -e . \
 && mkdir -p /api/langgraph_api /api/langgraph_runtime /api/langgraph_license \
 && touch /api/langgraph_api/__init__.py /api/langgraph_runtime/__init__.py /api/langgraph_license/__init__.py \
 && PYTHONDONTWRITEBYTECODE=1 uv pip install --system --no-cache-dir --no-deps -e /api \
 && uv pip uninstall --system pip setuptools wheel \
 && rm -rf /usr/local/lib/python*/site-packages/pip* /usr/local/lib/python*/site-packages/setuptools* \
           /usr/local/lib/python*/site-packages/wheel* /usr/bin/uv /usr/bin/uvx \
 && find /usr/local/bin /usr/bin -name "pip*" -delete \
 && rm -rf /app/datadog-init /dd_tracer \
 && useradd --system --uid 10001 --no-create-home app

ENV LANGSERVE_GRAPHS='{"supervisor": "/deps/agents/src/gamenight_agents/graphs/supervisor.py:graph"}'

USER 10001
