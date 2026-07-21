# Build from the repository root:
# docker build --file docker/codex/Dockerfile --tag chatmux-sandbox:codex .
FROM docker/sandbox-templates:codex

USER root
WORKDIR /opt/chatmux
COPY --chown=agent:agent package.json package-lock.json LICENSE NOTICE ./
COPY --chown=agent:agent dist ./dist
COPY --chown=agent:agent dist-server ./dist-server
COPY --chown=agent:agent public ./public
COPY --chown=agent:agent shared ./shared
COPY --chown=agent:agent node_modules ./node_modules
COPY docker/shared/install-chatmux.sh /tmp/install-chatmux.sh
RUN chmod +x /tmp/install-chatmux.sh && /tmp/install-chatmux.sh /opt/chatmux

COPY --chown=agent:agent docker/shared/start-chatmux.sh /home/agent/.chatmux-start.sh
RUN printf '\n. /home/agent/.chatmux-start.sh\n' >> /home/agent/.bashrc

USER agent
WORKDIR /home/agent
