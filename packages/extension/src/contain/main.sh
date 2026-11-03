case $action in
  attach) roots=$*; backend_attach $(descendants "$@") || exit 1 ;;
  kill) reap ;;
esac
