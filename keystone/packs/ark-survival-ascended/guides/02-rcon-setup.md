# Setting up RCON on your server

RCON lets Keystone send commands straight to your server over the network, without you being in the game. Saving the world, setting the time, messaging players and giving items to other players all go through it.

## On the server

Your server needs three settings. They go in `GameUserSettings.ini` under `[ServerSettings]`:

```
RCONEnabled=True
RCONPort=27020
ServerAdminPassword=your-admin-password
```

Most server hosts show these as fields in their control panel instead; look for **RCON** or **Admin**. Some hosts assign a different RCON port than 27020. Use whatever port they give you.

Restart the server after changing them.

## In Keystone

1. Pick **ARK: Survival Ascended** in the game switcher.
2. Open **Commands**, then **Settings**.
3. Under **RCON**, enter your server's IP address (or host name), the RCON port and the admin password, then **Save RCON**.
4. Press **Test connection**. You should see the list of players online.

## If the test fails

- **"Nothing is answering"**: the port is wrong, RCON isn't enabled, or the server is still starting.
- **"Couldn't reach"**: the address is wrong, or a firewall is blocking the RCON port. If you host the server yourself, allow the RCON port (TCP) through the firewall and router. With a host, check that the port they show is the RCON port, not the game or query port.
- **"Rejected the RCON password"**: use the server's admin password, not the join password.

Keystone stores the password encrypted with your Windows account's key.
