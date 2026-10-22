FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv dbus openssh-server python3 ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && useradd -m -s /bin/bash probe && passwd -d probe && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/fixture.conf && systemctl enable ssh
RUN rm -f /etc/machine-id /var/lib/dbus/machine-id && touch /etc/machine-id
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
