# How the User imports

The templates surface in settings is the whole path:

1. They paste the share link.
2. The app plans the import against this deployment's Packages and their
   already-installed set. Missing Packages are listed as missing, never
   installed from outside this deployment.
3. They review the steps: Bot create, Package installs this account does not
   yet have, Skill writes, Routine creates.
4. They apply. The apply takes exactly the planned steps.

You are not in that loop. If they ask what will happen, say those four
steps. If they ask you to click apply, say you cannot.
