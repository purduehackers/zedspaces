# Keep interactive workspace terminals focused on the current directory.
case $- in
  *i*) PS1='\w\$ ' ;;
esac
