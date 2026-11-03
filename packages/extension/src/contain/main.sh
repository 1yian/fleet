case $action in
  attach) roots=$*; backend_attach $(descendants "$@") ;;
  kill) reap ;;
esac
