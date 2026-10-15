FROM freeradius/freeradius-server:3.2.5
# Jatelo Connect configuration on top of the stock image
COPY clients.conf /etc/raddb/clients.conf
COPY mods-available/sql /etc/raddb/mods-available/sql
COPY mods-config/sql/main/postgresql/queries.conf /etc/raddb/mods-config/sql/main/postgresql/queries.conf
COPY sites-available/default /etc/raddb/sites-available/default
COPY sites-available/dynamic-clients /etc/raddb/sites-available/dynamic-clients
RUN ln -sf ../mods-available/sql /etc/raddb/mods-enabled/sql \
 && ln -sf ../sites-available/dynamic-clients /etc/raddb/sites-enabled/dynamic-clients \
 && rm -f /etc/raddb/sites-enabled/inner-tunnel /etc/raddb/mods-enabled/eap \
 && chown -R freerad:freerad /etc/raddb
CMD ["radiusd", "-f", "-l", "stdout"]
